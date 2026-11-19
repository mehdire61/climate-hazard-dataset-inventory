const test=require('node:test');
const assert=require('node:assert/strict');
const G=require('../src/geometry.js');
const turf=require('../vendor/turf.min.js');
const area=(geometry,bufferKm=0)=>({mode:'area',geometry:G.normalize(geometry),bufferKm});
const ring=(w,s,e,n)=>[[w,s],[e,s],[e,n],[w,n],[w,s]];
const polygon=(w,s,e,n)=>({type:'Polygon',coordinates:[ring(w,s,e,n)]});
const station=(lon,lat)=>({id:'test',lon,lat});
const inBoxes=(point,boxes)=>{const lon=((point[0]+180)%360+360)%360-180;return boxes.some(b=>lon>=b[0]-1e-9&&lon<=b[2]+1e-9&&point[1]>=b[1]-1e-9&&point[1]<=b[3]+1e-9);};

test('normalization preserves exact coordinate values/type and freezes only the accepted copy',()=>{
  const input=polygon(-77,38,-76,39),original=JSON.stringify(input),normalized=G.normalize(input);
  assert.deepEqual(normalized,input);assert.equal(JSON.stringify(input),original);
  assert.ok(Object.isFrozen(normalized.coordinates[0][0]));assert.equal(G.normalize(normalized),normalized);
  input.coordinates[0][1]=[500,38];assert.equal(normalized.coordinates[0][1][0],-76);
  assert.throws(()=>G.normalize(input),/Coordinates/);
  for(const type of ['Polygon','MultiPolygon']) {
    const geometry=type==='Polygon'?polygon(0,0,1,1):{type,coordinates:[polygon(0,0,1,1).coordinates]};
    assert.deepEqual(G.normalize({type:'FeatureCollection',features:[{type:'Feature',properties:{name:'Source'},geometry}]}),geometry);
  }
});
test('FeatureCollection combines all polygon features without merging or centroids',()=>{
  const q=area({type:'FeatureCollection',features:[{type:'Feature',properties:{},geometry:polygon(0,0,1,1)},{type:'Feature',properties:{},geometry:polygon(10,10,11,11)}]});
  assert.equal(q.geometry.type,'MultiPolygon');
  assert.equal(G.classify(q,station(0.5,0.5)).included,true);
  assert.equal(G.classify(q,station(10.5,10.5)).included,true);
  assert.equal(G.classify(q,station(5.5,5.5)).included,false);
});
test('coordinates, supported types, CRS and rings are validated without guessed repairs',()=>{
  for(const input of [null,{type:'Point',coordinates:[0,0]},{type:'GeometryCollection',geometries:[]},
    {type:'FeatureCollection',features:[]},{type:'Feature',geometry:{type:'Feature',geometry:polygon(0,0,1,1)}},
    {type:'Polygon',coordinates:[]},{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,1]]]},
    {type:'Polygon',coordinates:[[[0,0,5,9],[1,0,5,9],[1,1,5,9],[0,0,5,9]]]},
    {type:'Polygon',coordinates:[[[0,0],[1,0],[NaN,1],[0,0]]]},
    {...polygon(0,0,1,1),crs:{type:'name',properties:{name:'EPSG:3857'}}}]) assert.throws(()=>G.normalize(input));
  assert.deepEqual(G.normalize({...polygon(0,0,1,1),crs:{type:'name',properties:{name:'EPSG:4326'}}}),polygon(0,0,1,1));
});
test('self-crossings, backtracking, zero-area and misplaced/nested holes fail explicitly',()=>{
  const bad=[
    [[[0,0],[2,2],[0,2],[2,0],[0,0]]],
    [[[0,0],[3,0],[1,0],[1,2],[0,2],[0,0]]],
    [[[0,0],[1,0],[2,0],[0,0]]],
    [ring(0,0,4,4),ring(5,5,6,6)],
    [ring(0,0,4,4),ring(1,1,3,3),ring(1.5,1.5,2,2)],
    [ring(0,0,4,4),ring(0,1,2,2)]
  ];
  for(const coordinates of bad)assert.throws(()=>G.normalize({type:'Polygon',coordinates}));
});
test('multipart overlap/duplicates fail while disjoint, adjacent and hole-island parts work',()=>{
  for(const parts of [[polygon(0,0,2,2).coordinates,polygon(1,1,3,3).coordinates],
    [polygon(0,0,4,4).coordinates,polygon(1,1,2,2).coordinates],
    [polygon(0,0,2,2).coordinates,polygon(0,0,2,2).coordinates],
    [polygon(0,0,2,1).coordinates,polygon(1,0,3,1).coordinates],
    [polygon(-1,-1,1,1).coordinates,[[[-1,0],[0,1],[1,0],[-1,0]]]]])assert.throws(()=>G.normalize({type:'MultiPolygon',coordinates:parts}));
  const adjacent=area({type:'MultiPolygon',coordinates:[polygon(0,0,1,1).coordinates,polygon(1,0,2,1).coordinates]});
  assert.equal(G.classify(adjacent,station(1,0.5)).relation,'inside');
  const island=area({type:'MultiPolygon',coordinates:[[ring(0,0,5,5),ring(1,1,4,4)],polygon(2,2,3,3).coordinates]});
  assert.equal(G.classify(island,station(2.5,2.5)).included,true);
});
test('holes exclude their interiors but boundaries belong to the footprint',()=>{
  const q=area({type:'Polygon',coordinates:[ring(0,0,4,4),ring(1,1,3,3)]});
  assert.deepEqual(G.classify(q,station(0,2)),{included:true,relation:'inside',distanceKm:0});
  assert.deepEqual(G.classify(q,station(1,2)),{included:true,relation:'inside',distanceKm:0});
  const hole=G.classify(q,station(2,2));assert.equal(hole.included,false);assert.ok(hole.distanceKm>110&&hole.distanceKm<112);
  assert.equal(G.classify({...q,bufferKm:112},station(2,2)).relation,'nearby');
  assert.equal(G.classify(q,station(4+1e-9,2)).included,false,'zero buffer never admits a truly outside point');
});
test('buffer distance is measured from polygon edges, not centroid or bounding circle',()=>{
  const q=area(polygon(0,0,10,1),12);
  const result=G.classify(q,station(9.9,1.1));
  assert.equal(result.relation,'nearby');assert.ok(Math.abs(result.distanceKm-11.119508)<0.00001);
  assert.equal(G.classify({...q,bufferKm:10},station(9.9,1.1)).included,false);
  assert.equal(G.classify(q,station(20,0.5)).included,false);
});
test('coordinate-linear latitude edges are not silently bowed into great-circle edges',()=>{
  const q=area(polygon(0,0,120,60),120),result=G.classify(q,station(60,61));
  assert.equal(result.relation,'nearby');assert.ok(Math.abs(result.distanceKm-111.1950802335)<1e-7);
});
test('point radius is adjustable, inclusive, defaults to100km and supports zero',()=>{
  const q={lat:0,lon:0};
  assert.equal(G.classify(q,station(0.5,0)).included,true);
  assert.equal(G.classify({...q,radiusKm:10},station(0.5,0)).included,false);
  assert.equal(G.classify({...q,radiusKm:0},station(0,0)).relation,'inside');
  assert.equal(G.classify({...q,radiusKm:0},station(1e-10,0)).included,false);
  const edge=turf.destination([0,0],100,90,{units:'kilometers'}).geometry.coordinates;
  assert.equal(G.classify(q,station(...edge)).included,true);
  for(const patch of [{radiusKm:-1},{radiusKm:'10'},{radiusKm:Infinity},{lat:91},{lon:null},{mode:'planet'}])assert.ok(G.validate({...q,...patch}).length);
  assert.ok(G.validate({mode:'area',geometry:G.rectangle(0,0,1,1),bufferKm:-1}).length);
});
test('point antipodes and poles have finite distances and equivalent co-locations',()=>{
  const antipode=G.classify({lat:0,lon:0,radiusKm:G.limits.maxRadiusKm},station(180,0));
  assert.ok(antipode.included);assert.ok(Math.abs(antipode.distanceKm-Math.PI*6371.0088)<1e-8);
  assert.equal(G.classify({lat:90,lon:0,radiusKm:0},station(180,90)).included,true);
  assert.equal(G.classify({lat:0,lon:180,radiusKm:0},station(-180,0)).included,true);
});
test('dateline rectangles are split; uncut longitude jumps are rejected without reinterpretation',()=>{
  const q=area(G.rectangle(170,-20,-170,20));
  assert.equal(q.geometry.type,'MultiPolygon');assert.equal(G.searchBoxes(q).length,2);
  for(const lon of [175,180,-180,-175])assert.equal(G.classify(q,station(lon,0)).included,true);
  assert.equal(G.classify(q,station(0,0)).included,false);
  assert.ok(Math.abs(G.center(q).lon)===180);
  assert.throws(()=>G.normalize(polygon(170,-20,-170,20)),/180°/);
});
test('search envelopes conservatively include radius/buffer neighborhoods at equator, dateline and poles',()=>{
  for(const q of [{lat:0,lon:0,radiusKm:300},{lat:45,lon:179.9,radiusKm:100},{lat:-89.5,lon:-120,radiusKm:200},{lat:90,lon:0,radiusKm:20}]){
    const boxes=G.searchBoxes(q);
    for(let bearing=0;bearing<360;bearing+=5){const point=turf.destination([q.lon,q.lat],q.radiusKm,bearing,{units:'kilometers'}).geometry.coordinates;assert.ok(inBoxes(point,boxes),JSON.stringify({q,bearing,point,boxes}));}
  }
  const q=area(G.rectangle(10,80,20,85),200),boxes=G.searchBoxes(q);
  for(const origin of [[10,80],[20,80],[10,85],[20,85]])for(let bearing=0;bearing<360;bearing+=10){const point=turf.destination(origin,200,bearing,{units:'kilometers'}).geometry.coordinates;assert.ok(inBoxes(point,boxes));}
});
test('nominal domain relation uses the whole original area, excludes buffer and respects holes',()=>{
  const wide=area(G.rectangle(-10,55,10,65),1000);
  assert.equal(G.domainRelation(wide,[-180,-60,180,60]),'partial');
  assert.equal(G.domainRelation(area(G.rectangle(-10,61,10,65),1000),[-180,-60,180,60]),'outside');
  assert.equal(G.domainRelation(area(G.rectangle(-10,55,10,59),1000),[-180,-60,180,60]),'within');
  const donut=area({type:'Polygon',coordinates:[ring(0,0,4,4),ring(1,1,3,3)]});
  assert.equal(G.domainRelation(donut,[1.2,1.2,2.8,2.8]),'outside');
  assert.equal(G.domainRelation(wide,[-180,-78,180,78],false),'unknown');
  assert.equal(G.domainRelation(wide,null),'unknown');
});
test('partial intersection is detected even when no area vertices lie in the domain',()=>{
  const q=area(G.rectangle(-5,-0.1,5,0.1));
  assert.equal(G.domainRelation(q,[-0.1,-5,0.1,5]),'partial');
  assert.equal(G.domainRelation(q,[4.9,0.1,5.1,1]),'partial','boundary intersection is retained');
});
test('domain dateline geometry and display center do not become analysis centroids',()=>{
  const q=area({type:'MultiPolygon',coordinates:[polygon(170,10,175,15).coordinates,polygon(-175,-15,-170,-10).coordinates]});
  assert.equal(G.domainRelation(q,[160,-20,-160,20]),'within');
  assert.equal(G.classify(q,station(G.center(q).lon,G.center(q).lat)).included,false);
  assert.deepEqual(G.mapGeometry(q).geometry,q.geometry);
});
test('complexity limits reject explicitly before expensive topology checks',()=>{
  const positions=Array.from({length:100000},(_,i)=>[Math.cos(i/100000*2*Math.PI),Math.sin(i/100000*2*Math.PI)]);positions.push(positions[0]);
  assert.throws(()=>G.normalize({type:'Polygon',coordinates:[positions]}),/100,000 vertices/);
});

// Independent derivative-free oracle: sample an edge, then golden-section-refine local minima.
function sphereDistance(a,b){const rad=Math.PI/180;const h=Math.sin((a[1]-b[1])*rad/2)**2+Math.cos(a[1]*rad)*Math.cos(b[1]*rad)*Math.sin((a[0]-b[0])*rad/2)**2;return 12742.0176*Math.atan2(Math.sqrt(Math.min(1,h)),Math.sqrt(Math.max(0,1-h)));}
function referenceEdge(point,a,b){
  const at=t=>sphereDistance(point,[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]),values=Array.from({length:65},(_,i)=>at(i/64));let best=Math.min(...values);
  for(let i=0;i<=64;i++)if((i===0||values[i]<=values[i-1])&&(i===64||values[i]<=values[i+1])){let lo=Math.max(0,i-1)/64,hi=Math.min(64,i+1)/64;for(let k=0;k<60;k++){const l=lo+(hi-lo)*0.38196601125,r=lo+(hi-lo)*0.61803398875;if(at(l)<at(r))hi=r;else lo=l;}best=Math.min(best,at((lo+hi)/2));}
  return best;
}
test('spherical edge minima agree with an independent numerical oracle across sizes/latitudes',()=>{
  let maxError=0,checked=0;
  for(let i=1;i<=180;i++){
    const x=Math.sin(i*7.13)*110,y=Math.cos(i*4.81)*65,size=Math.pow(10,-3+(i%40)/10);
    const points=[[x,y],[x+size,y+size*0.7],[x+size*0.1,y+size*1.3],[x,y]];
    const q=area({type:'Polygon',coordinates:[points]});
    const point=[x+size*(Math.sin(i*2.3)*2),y+size*(Math.cos(i*1.7)*2)];
    const result=G.classify(q,station(...point));if(result.relation==='inside')continue;
    const reference=Math.min(...points.slice(0,-1).map((a,j)=>referenceEdge(point,a,points[j+1])));
    const error=Math.abs(result.distanceKm-reference);maxError=Math.max(maxError,error);checked++;
    assert.ok(error<0.000001,JSON.stringify({i,error,actual:result.distanceKm,reference}));
  }
  assert.ok(checked>100);assert.ok(maxError<0.000001);
});
