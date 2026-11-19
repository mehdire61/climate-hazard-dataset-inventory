/* Project geometry, not a centroid proxy. GeoJSON edges retain their coordinate-linear meaning. */
(function (root) {
  'use strict';
  const turf = root.turf || (typeof require === 'function' ? require('../vendor/turf.min.js') : null);
  const EARTH_KM = 6371.0088, RAD = Math.PI / 180, EPS = 1e-10;
  const MAX_VERTICES = 100000, MAX_PARTS = 5000, MAX_PAIRS = 10000000;
  const cache = new WeakMap();
  function fail(message) { const error = new Error(message); error.code = 'GEOMETRY'; throw error; }
  function position(c) { return Array.isArray(c) && (c.length === 2 || c.length === 3) && c.every(Number.isFinite) && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90; }
  function same(a,b) { return a[0] === b[0] && a[1] === b[1]; }
  function freeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) {Object.values(value).forEach(freeze); Object.freeze(value);} return value; }
  function checkCRS(value) {
    if (!value || !Object.prototype.hasOwnProperty.call(value, 'crs')) return;
    const name = value.crs?.properties?.name;
    if (value.crs?.type !== 'name' || !['EPSG:4326','urn:ogc:def:crs:OGC:1.3:CRS84','urn:ogc:def:crs:OGC::CRS84','urn:ogc:def:crs:EPSG::4326'].includes(name)) {
      fail('Use WGS84 GeoJSON with longitude, latitude coordinates. Projected or unknown CRS declarations are not accepted or reprojected.');
    }
  }
  function collect(input, parts) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Provide a GeoJSON Polygon, MultiPolygon, Feature or polygon-only FeatureCollection.');
    checkCRS(input);
    if (input.type === 'Feature') {
      if(!['Polygon','MultiPolygon'].includes(input.geometry?.type))fail('A polygon Feature must contain Polygon or MultiPolygon geometry.');
      return collect(input.geometry, parts);
    }
    if (input.type === 'FeatureCollection') {
      if (!Array.isArray(input.features) || !input.features.length) fail('The FeatureCollection must contain polygon features.');
      for (const feature of input.features) {if (feature?.type !== 'Feature') fail('FeatureCollection entries must be Features.'); collect(feature,parts);}
      return;
    }
    if (input.type === 'Polygon') parts.push(input.coordinates);
    else if (input.type === 'MultiPolygon' && Array.isArray(input.coordinates)) {
      if(parts.length+input.coordinates.length>MAX_PARTS)fail(`The footprint has more than ${MAX_PARTS.toLocaleString('en-US')} polygon parts. Choose a smaller footprint; no simplification was applied.`);
      for(const polygon of input.coordinates)parts.push(polygon);
    }
    else fail('Only Polygon and MultiPolygon footprints are supported; points, lines and mixed collections are not project areas.');
    if (parts.length > MAX_PARTS) fail(`The footprint has more than ${MAX_PARTS.toLocaleString('en-US')} polygon parts. Choose a smaller footprint; no simplification was applied.`);
  }
  function signedArea(ring) {
    const origin = ring[0]; let area = 0;
    for (let i=0; i<ring.length-1; i++) area += (ring[i][0]-origin[0])*(ring[i+1][1]-origin[1])-(ring[i+1][0]-origin[0])*(ring[i][1]-origin[1]);
    return area / 2;
  }
  function onSegment(p,a,b) {
    const cross = (p[0]-a[0])*(b[1]-a[1])-(p[1]-a[1])*(b[0]-a[0]);
    return Math.abs(cross) <= EPS * Math.max(1,Math.abs(b[0]-a[0]),Math.abs(b[1]-a[1])) &&
      p[0] >= Math.min(a[0],b[0])-EPS && p[0] <= Math.max(a[0],b[0])+EPS && p[1] >= Math.min(a[1],b[1])-EPS && p[1] <= Math.max(a[1],b[1])+EPS;
  }
  function cross(a,b,c) {return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);}
  function segmentHit(a,b,c,d) {
    const abC=cross(a,b,c),abD=cross(a,b,d),cdA=cross(c,d,a),cdB=cross(c,d,b);
    if ((abC > EPS && abD < -EPS || abC < -EPS && abD > EPS) && (cdA > EPS && cdB < -EPS || cdA < -EPS && cdB > EPS)) return 'cross';
    if (onSegment(a,c,d) || onSegment(b,c,d) || onSegment(c,a,b) || onSegment(d,a,b)) return 'touch';
    return null;
  }
  function intersectsBox(a,b) { return a[0] <= b[2]+EPS && a[2] >= b[0]-EPS && a[1] <= b[3]+EPS && a[3] >= b[1]-EPS; }
  function segmentTree(segments) {
    const box=[Infinity,Infinity,-Infinity,-Infinity];
    for(const segment of segments){box[0]=Math.min(box[0],segment.box[0]);box[1]=Math.min(box[1],segment.box[1]);box[2]=Math.max(box[2],segment.box[2]);box[3]=Math.max(box[3],segment.box[3]);}
    if(segments.length<=12)return {box,segments};
    const axis=box[2]-box[0]>=box[3]-box[1]?0:1;
    segments.sort((a,b)=>(a.box[axis]+a.box[axis+2])-(b.box[axis]+b.box[axis+2]));
    const mid=Math.floor(segments.length/2);
    return {box,left:segmentTree(segments.slice(0,mid)),right:segmentTree(segments.slice(mid))};
  }
  function topology(parts, segments, boxes) {
    // X sweep limits comparisons to intersecting segment envelopes; never run all-pairs Turf kinks.
    const ordered=[...segments].sort((a,b)=>a.box[0]-b.box[0]), touchingParts=new Set(); let active=[], work=0;
    const started=Date.now(), sizes=parts.map(polygon=>polygon.reduce((n,ring)=>n+ring.length,0));
    function charge(amount=1) {
      work+=amount;
      if(work>MAX_PAIRS || Date.now()-started>1500) fail('Boundary validation reached its complexity limit (10 million work units or 1.5 seconds). Choose a smaller area or an explicitly prepared coarser boundary; no simplification was applied.');
    }
    const contains=(point,polygon,size,options)=>{charge(size);return turf.booleanPointInPolygon(point,polygon,options);};
    const partPair=(a,b)=>a<b?`${a},${b}`:`${b},${a}`;
    for (const segment of ordered) {
      active=active.filter(other=>{charge();return other.box[2] >= segment.box[0]-EPS;});
      for (const other of active) {
        charge();
        if (!intersectsBox(segment.box,other.box)) continue;
        if (segment.part === other.part && segment.ring === other.ring &&
          (Math.abs(segment.index-other.index) === 1 || Math.abs(segment.index-other.index) === segment.last)) continue;
        const hit=segmentHit(segment.a,segment.b,other.a,other.b);
        if (!hit) continue;
        if (segment.part === other.part) fail('The footprint has a self-intersection, overlapping edge, or touching/intersecting hole. Repair its topology before use; no repair was applied.');
        if (hit === 'cross') fail('MultiPolygon parts overlap or cross. Provide nonoverlapping polygon parts.');
        touchingParts.add(partPair(segment.part,other.part));
      }
      active.push(segment);
    }
    for (let p=0;p<parts.length;p++) {
      const polygon=parts[p], outer=turf.polygon([polygon[0]]), holes=polygon.slice(1).map(ring=>({shape:turf.polygon([ring]),box:turf.bbox(turf.polygon([ring]))}));
      for (let h=1;h<polygon.length;h++) {
        if (!contains(polygon[h][0],outer,polygon[0].length,{ignoreBoundary:true})) fail('Every hole must lie strictly inside its outer ring.');
        for (let k=1;k<h;k++) {
          charge();
          if (!intersectsBox(holes[h-1].box,holes[k-1].box)) continue;
          if (contains(polygon[h][0],holes[k-1].shape,polygon[k].length) || contains(polygon[k][0],holes[h-1].shape,polygon[h].length)) fail('Nested or overlapping holes are not accepted.');
        }
      }
    }
    // Crossing boundaries were rejected above. Test containment and coincident polygons separately.
    const order=boxes.map((box,part)=>({box,part})).sort((a,b)=>a.box[0]-b.box[0]); active=[];
    for (const current of order) {
      active=active.filter(other=>{charge();return other.box[2] >= current.box[0]-EPS;});
      for (const other of active) {
        charge();
        if (!intersectsBox(current.box,other.box)) continue;
        const a=turf.polygon(parts[current.part]), b=turf.polygon(parts[other.part]);
        const inBox=(point,box)=>point[0]>=box[0]&&point[0]<=box[2]&&point[1]>=box[1]&&point[1]<=box[3];
        // With no boundary crossings or touches, containment is constant along
        // each connected exterior ring. One vertex suffices; touching rings
        // retain the exhaustive check below.
        const touching=touchingParts.has(partPair(current.part,other.part));
        const aPoints=touching?parts[current.part][0]:parts[current.part][0].slice(0,1);
        const bPoints=touching?parts[other.part][0]:parts[other.part][0].slice(0,1);
        const aInside=aPoints.some(point=>{charge();return inBox(point,other.box)&&contains(point,b,sizes[other.part],{ignoreBoundary:true});});
        const bInside=bPoints.some(point=>{charge();return inBox(point,current.box)&&contains(point,a,sizes[current.part],{ignoreBoundary:true});});
        if (aInside || bInside) fail('MultiPolygon parts overlap or contain one another. An island within another polygon’s hole is allowed, but overlapping area is not.');
        // Shared boundaries or inscribed parts can conceal overlap with no strictly interior vertex.
        if (touchingParts.has(partPair(current.part,other.part)) || current.box.every((v,i)=>Math.abs(v-other.box[i])<EPS)) {
          charge(sizes[current.part]*sizes[other.part]);
          const overlap=turf.intersect(turf.featureCollection([a,b]));
          if (overlap) fail('Overlapping, duplicate or coincident polygon parts are not accepted.');
        }
      }
      active.push(current);
    }
  }
  function prepare(input) {
    if (input && cache.has(input)) return cache.get(input);
    if (!turf) fail('The bundled geometry library is unavailable.');
    const raw=[];collect(input,raw);
    if (!raw.length) fail('An area needs at least one nonempty polygon.');
    let count=0, altitudeCount=0; const segments=[],boxes=[];
    const parts=raw.map((polygon,part)=>{
      if (!Array.isArray(polygon) || !polygon.length) fail('Each polygon needs an outer ring.');
      const rings=polygon.map((ring,r)=>{
        if (!Array.isArray(ring) || ring.length<4) fail('Each ring needs at least four positions, including its closing position.');
        count+=ring.length;
        if (count>MAX_VERTICES) fail(`The footprint exceeds ${MAX_VERTICES.toLocaleString('en-US')} vertices. Choose a smaller footprint or explicitly prepare a coarser source; no simplification was applied.`);
        const points=ring.map(c=>{if (!position(c)) fail('Coordinates must be finite WGS84 [longitude, latitude] pairs, with optional altitude as a third number. Projected coordinates are not accepted.');if(c.length===3)altitudeCount++;return [c[0],c[1]];});
        if (!same(points[0],points[points.length-1])) fail('Polygon rings must be explicitly closed; automatic closure is not applied.');
        const unique=new Set();
        for(let i=0;i<points.length-1;i++) {
          const key=points[i].join(',');
          if(unique.has(key)) fail('A ring repeats a vertex before closure. Repair the duplicate or self-touching boundary explicitly.');
          unique.add(key);
          if (Math.abs(points[i+1][0]-points[i][0])>=360-EPS) fail('An edge from -180° to +180° is ambiguous: the same meridian could mean zero width or the whole world. Use the rectangle tool for a full-longitude area, or split the GeoJSON at the dateline.');
          if (Math.abs(points[i+1][0]-points[i][0])>180+EPS) fail('An edge jumps more than 180° longitude. Split a dateline-crossing footprint at ±180° (RFC7946) or use the rectangle tool; no wrap was guessed.');
          segments.push({a:points[i],b:points[i+1],part,ring:r,index:i,last:points.length-2,box:[Math.min(points[i][0],points[i+1][0]),Math.min(points[i][1],points[i+1][1]),Math.max(points[i][0],points[i+1][0]),Math.max(points[i][1],points[i+1][1])]});
        }
        if(unique.size<3) fail('A ring has zero or numerically negligible area.');
        return points;
      });
      boxes.push(turf.bbox(turf.polygon(rings)));
      return rings;
    });
    topology(parts,segments,boxes);
    if(parts.some(polygon=>polygon.some(ring=>Math.abs(signedArea(ring))<1e-14))) fail('A ring has zero or numerically negligible area.');
    let base=input;
    if(base.type==='FeatureCollection' && base.features.length===1)base=base.features[0];
    if(base.type==='Feature')base=base.geometry;
    const geometry=freeze(parts.length===1 && base.type!=='MultiPolygon' && base.type!=='FeatureCollection' ? {type:'Polygon',coordinates:parts[0]} : {type:'MultiPolygon',coordinates:parts});
    const prepared={geometry,parts,segments,boxes,tree:segmentTree([...segments]),vertices:count,altitudeCount};
    cache.set(geometry,prepared); // Only immutable normalized geometry is trusted by the cache.
    return prepared;
  }
  function normalize(input) {return prepare(input).geometry;}
  function normalizationNotes(input) {return prepare(input).altitudeCount ? ['Altitude coordinates were omitted; area screening uses longitude and latitude only.'] : [];}
  function mode(query) {return query?.mode || 'point';}
  function size(query) {return mode(query)==='area' ? query.bufferKm ?? 0 : query.radiusKm ?? 100;}
  function validate(query) {
    const errors=[];
    if (!query || typeof query !== 'object') return ['Enter a point or project area.'];
    if (!['point','area'].includes(mode(query))) return ['Choose Point or Area mode.'];
    const radius=size(query);
    if (!Number.isFinite(radius) || radius<0 || radius>Math.PI*EARTH_KM) errors.push(`${mode(query)==='area'?'Area buffer':'Point search radius'} must be a number from 0 to ${(Math.PI*EARTH_KM).toFixed(1)} km.`);
    if (mode(query)==='point') {
      if (!Number.isFinite(query.lat) || Math.abs(query.lat)>90) errors.push('Latitude must be a number from −90 to 90.');
      if (!Number.isFinite(query.lon) || Math.abs(query.lon)>180) errors.push('Longitude must be a number from −180 to 180.');
    } else {try {prepare(query.geometry);} catch(error) {errors.push(error.message);}}
    return errors;
  }
  function check(query) {const errors=validate(query);if(errors.length)fail(errors.join(' '));}
  function wrap(lon) {const value=((lon+180)%360+360)%360-180;return value===-180 && lon>0 ? 180:value;}
  function angularDistance(a,b) {
    const dlat=(a[1]-b[1])*RAD,dlon=(a[0]-b[0])*RAD;
    const h=Math.sin(dlat/2)**2+Math.cos(a[1]*RAD)*Math.cos(b[1]*RAD)*Math.sin(dlon/2)**2;
    return 2*Math.atan2(Math.sqrt(Math.min(1,h)),Math.sqrt(Math.max(0,1-h)));
  }
  function distance(a,b) {return EARTH_KM*angularDistance(a,b);}
  function boxDistanceLower(point,box) {
    const latGap=point[1]<box[1]?box[1]-point[1]:point[1]>box[3]?point[1]-box[3]:0;
    let lonGap=Infinity;
    for(const shift of [-360,0,360]){const lon=point[0]+shift;lonGap=Math.min(lonGap,lon<box[0]?box[0]-lon:lon>box[2]?lon-box[2]:0);}
    const longitude=Math.asin(Math.min(1,Math.cos(point[1]*RAD)*Math.sin(Math.min(lonGap,90)*RAD)));
    return EARTH_KM*Math.max(latGap*RAD,longitude);
  }
  function longitudeEnvelope(boxes) {
    const intervals=boxes.map(b=>[b[0],b[2]]).sort((a,b)=>a[0]-b[0]), merged=[];
    for(const interval of intervals){const last=merged[merged.length-1];if(last && interval[0]<=last[1])last[1]=Math.max(last[1],interval[1]);else merged.push([...interval]);}
    let gap=-1,west=-180,east=180;
    for(let i=0;i<merged.length;i++) {
      const next=merged[(i+1)%merged.length],width=next[0]+(i===merged.length-1?360:0)-merged[i][1];
      if(width>gap){gap=width;west=next[0];east=merged[i][1];}
    }
    return gap<=EPS?[-180,180]:[west,east];
  }
  function expandBox(west,south,east,north,radius) {
    const angular=radius/EARTH_KM,pad=angular/RAD;
    const s=Math.max(-90,south-pad),n=Math.min(90,north+pad);
    const width=west<=east?east-west:360-west+east;
    if(s<=-90 || n>=90 || width>=360-EPS) return [[-180,s,180,n]];
    if(radius===0)return west<=east?[[west,south,east,north]]:[[west,south,180,north],[-180,south,east,north]];
    const lonPad=Math.asin(Math.min(1,Math.sin(angular)/Math.cos(Math.max(Math.abs(south),Math.abs(north))*RAD)))/RAD;
    if(width+2*lonPad>=360-EPS)return [[-180,s,180,n]];
    const w=wrap(west-lonPad-EPS),e=wrap(east+lonPad+EPS);
    const paddedSouth=Math.max(-90,s-EPS),paddedNorth=Math.min(90,n+EPS);
    return w<=e?[[w,paddedSouth,e,paddedNorth]]:[[w,paddedSouth,180,paddedNorth],[-180,paddedSouth,e,paddedNorth]];
  }
  function searchBoxes(query) {
    check(query);
    if(mode(query)==='point')return expandBox(query.lon,query.lat,query.lon,query.lat,size(query));
    const {boxes}=prepare(query.geometry),[west,east]=longitudeEnvelope(boxes);
    return expandBox(west,Math.min(...boxes.map(b=>b[1])),east,Math.max(...boxes.map(b=>b[3])),size(query));
  }
  function inside(point, prepared) {
    for(let i=0;i<prepared.parts.length;i++) {
      const polygon=prepared.parts[i], box=prepared.boxes[i];
      if(Math.abs(point[1])===90 && polygon[0].some(p=>p[1]===point[1]))return true;
      for(const lon of Math.abs(point[0])===180?[point[0],-point[0]]:[point[0]]) {
        if(lon<box[0]-EPS || lon>box[2]+EPS || point[1]<box[1]-EPS || point[1]>box[3]+EPS)continue;
        if(turf.booleanPointInPolygon([lon,point[1]],turf.polygon(polygon),{ignoreBoundary:false}))return true;
      }
    }
    return false;
  }
  // Great-circle metric to the original coordinate-linear GeoJSON edge. Long edges are divided
  // into <=1° parameter intervals for numerical minimization; geometry itself is never changed.
  function edgeDistance(point,a,b,best=Infinity) {
    const dx=b[0]-a[0],dy=b[1]-a[1];
    const minLat=Math.min(a[1],b[1]),maxLat=Math.max(a[1],b[1]);
    const latLower=point[1]<minLat?minLat-point[1]:point[1]>maxLat?point[1]-maxLat:0;
    if(latLower*RAD*EARTH_KM>best)return Infinity;
    const west=Math.min(a[0],b[0]),east=Math.max(a[0],b[0]);
    const gap=Math.min(...[point[0]-360,point[0],point[0]+360].map(lon=>lon<west?west-lon:lon>east?lon-east:0));
    const longitudeLower=Math.asin(Math.min(1,Math.cos(point[1]*RAD)*Math.sin(Math.min(gap,90)*RAD)))*EARTH_KM;
    if(longitudeLower>best)return Infinity;
    if(dy===0) {
      let value=Infinity;
      for(const lon of [point[0]-360,point[0],point[0]+360])value=Math.min(value,distance(point,[Math.max(Math.min(a[0],b[0]),Math.min(Math.max(a[0],b[0]),lon)),a[1]]));
      return value;
    }
    if(dx===0) return turf.pointToLineDistance(point,turf.lineString([a,b]),{method:'geodesic',units:'kilometers'});
    const n=Math.ceil(Math.max(Math.abs(dx),Math.abs(dy)));
    const at=t=>distance(point,[a[0]+dx*t,a[1]+dy*t]);
    const lat0=a[1]*RAD,lon0=(a[0]-point[0])*RAD,blat=dy*RAD,blon=dx*RAD,sp=Math.sin(point[1]*RAD),cp=Math.cos(point[1]*RAD);
    // Derivatives of the dot product between unit vectors: maximizing it minimizes angular distance.
    const derivatives=t=>{
      const lat=lat0+blat*t,lon=lon0+blon*t,s=Math.sin(lat),c=Math.cos(lat),sl=Math.sin(lon),cl=Math.cos(lon);
      return [sp*blat*c-cp*(blat*s*cl+blon*c*sl),-sp*blat*blat*s+cp*(-(blat*blat+blon*blon)*c*cl+2*blat*blon*s*sl)];
    };
    function maximum(low,high) {
      let t=(low+high)/2;
      for(let k=0;k<24;k++) {
        const [first,second]=derivatives(t);
        if(first>0)low=t;else high=t;
        const next=second!==0?t-first/second:NaN;
        const proposed=Number.isFinite(next)&&next>low&&next<high?next:(low+high)/2;
        if(Math.abs(proposed-t)*Math.max(Math.abs(dx),Math.abs(dy))<1e-10)return at(proposed);
        t=proposed;
      }
      return at(t);
    }
    let result=Math.min(at(0),at(1));
    for(let j=0;j<n;j++) {
      let low=j/n,high=(j+1)/n;
      const leftLat=a[1]+dy*low,rightLat=a[1]+dy*high;
      const lower=point[1]<Math.min(leftLat,rightLat)?Math.min(leftLat,rightLat)-point[1]:point[1]>Math.max(leftLat,rightLat)?point[1]-Math.max(leftLat,rightLat):0;
      if(lower*RAD*EARTH_KM>Math.min(best,result))continue;
      const middle=(low+high)/2,f0=derivatives(low)[0],fm=derivatives(middle)[0],f1=derivatives(high)[0];
      result=Math.min(result,at(low),at(high));
      if(f0>0&&fm<0)result=Math.min(result,maximum(low,middle));
      if(fm>0&&f1<0)result=Math.min(result,maximum(middle,high));
      if(fm===0)result=Math.min(result,at(middle));
    }
    return result;
  }
  function classify(query,station) {
    check(query);
    if(!station || !position([station.lon,station.lat]))fail('Station coordinates must be finite WGS84 longitude/latitude values.');
    const point=[station.lon,station.lat];
    if(mode(query)==='point') {
      const coincident=query.lat===station.lat&&(query.lon===station.lon||Math.abs(query.lon)===180&&Math.abs(station.lon)===180||Math.abs(query.lat)===90);
      const distanceKm=coincident?0:distance(point,[query.lon,query.lat]),included=size(query)===0?coincident:distanceKm<=size(query)+1e-7;
      return {included,relation:included?(coincident?'inside':'nearby'):'outside',distanceKm};
    }
    const prepared=prepare(query.geometry);
    if(inside(point,prepared))return {included:true,relation:'inside',distanceKm:0};
    // Cached segment tree prunes only with conservative spherical lower bounds.
    let distanceKm=Infinity;
    function visit(node) {
      if(boxDistanceLower(point,node.box)>distanceKm+1e-9)return;
      if(node.segments){for(const segment of node.segments)distanceKm=Math.min(distanceKm,edgeDistance(point,segment.a,segment.b,distanceKm));return;}
      const left=boxDistanceLower(point,node.left.box),right=boxDistanceLower(point,node.right.box);
      if(left<=right){visit(node.left);visit(node.right);}else{visit(node.right);visit(node.left);}
    }
    visit(prepared.tree);
    const included=size(query)>0&&distanceKm<=size(query)+1e-6;
    return {included,relation:included?'nearby':'outside',distanceKm};
  }
  function includesStation(query,station) {
    // An unbuffered polygon needs only containment, not the distance to its
    // nearest edge for each outside station in an index.
    if(mode(query)==='area'&&size(query)===0)return inside([station.lon,station.lat],prepare(query.geometry));
    return classify(query,station).included;
  }
  function validBounds(bounds) {return Array.isArray(bounds)&&bounds.length===4&&bounds.every(Number.isFinite)&&Math.abs(bounds[0])<=180&&Math.abs(bounds[2])<=180&&bounds[1]>=-90&&bounds[3]<=90&&bounds[1]<=bounds[3];}
  function domainRelation(query,bounds,hardBounds=true) {
    if(!validBounds(bounds)||hardBounds!==true)return 'unknown';
    check(query);
    const [west,south,east,north]=bounds;
    const boxes=west<=east?[bounds]:[[west,south,180,north],[-180,south,east,north]];
    if(mode(query)==='point') {
      if(Math.abs(query.lat)===90 && query.lat>=south && query.lat<=north)return 'within';
      for(const lon of Math.abs(query.lon)===180?[query.lon,-query.lon]:[query.lon])if(boxes.some(b=>lon>=b[0]&&lon<=b[2]&&query.lat>=b[1]&&query.lat<=b[3]))return 'within';
      return 'outside';
    }
    const prepared=prepare(query.geometry);
    if(prepared.boxes.every(p=>boxes.some(b=>p[0]>=b[0]&&p[2]<=b[2]&&p[1]>=b[1]&&p[3]<=b[3])))return 'within';
    for(let i=0;i<prepared.parts.length;i++)for(const box of boxes) {
      if(!intersectsBox(prepared.boxes[i],box))continue;
      if(turf.booleanIntersects(turf.polygon(prepared.parts[i]),turf.bboxPolygon(box)))return 'partial';
    }
    return 'outside';
  }
  function mapGeometry(query) {
    check(query);
    return {type:'Feature',properties:{mode:mode(query),name:query.areaName||'Project point'},geometry:mode(query)==='area'?normalize(query.geometry):{type:'Point',coordinates:[query.lon,query.lat]}};
  }
  function areaKm2(shape) {
    return turf.area(turf.feature(normalize(shape))) / 1000000;
  }
  function center(query) {
    check(query);
    if(mode(query)==='point')return {lat:query.lat,lon:query.lon};
    const {boxes}=prepare(query.geometry),[west,east]=longitudeEnvelope(boxes),width=west<=east?east-west:360-west+east;
    return {lat:(Math.min(...boxes.map(b=>b[1]))+Math.max(...boxes.map(b=>b[3])))/2,lon:wrap(west+width/2)};
  }
  function rectangle(west,south,east,north) {
    if(!validBounds([west,south,east,north]) || south===north || west===east)fail('A rectangle needs valid west/south/east/north bounds with positive width and height. West greater than east explicitly crosses the dateline.');
    const ranges=west<=east?[[west,east]]:[[west,180],[-180,east]],parts=[];
    for(const [w,e] of ranges) {
      if(w===e)continue;
      const slices=Math.ceil((e-w)/180);
      for(let i=0;i<slices;i++){const a=w+(e-w)*i/slices,b=w+(e-w)*(i+1)/slices;parts.push([[[a,south],[b,south],[b,north],[a,north],[a,south]]]);}
    }
    return normalize(parts.length===1?{type:'Polygon',coordinates:parts[0]}:{type:'MultiPolygon',coordinates:parts});
  }
  const api=Object.freeze({validate,normalize,normalizationNotes,searchBoxes,classify,includesStation,domainRelation,mapGeometry,areaKm2,center,rectangle,
    limits:Object.freeze({maxVertices:MAX_VERTICES,maxParts:MAX_PARTS,maxRadiusKm:Math.PI*EARTH_KM}),
    distanceMethod:'Spherical great-circle distance, mean Earth radius 6371.0088 km, minimized to original coordinate-linear GeoJSON edges; not an ellipsoidal survey distance.'});
  root.SiteGeometry=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
