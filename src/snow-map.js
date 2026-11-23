/* A single source-backed, offline example shared by the two snow records. */
(function (root) {
  'use strict';
  let nextMap = 0;
  const bands = [
    ['0','#fbf4df'], ['1–199','#cce6df'], ['200–399','#80bfbf'],
    ['400–599','#418ba6'], ['600+','#1f5477'], ['No data','#e3e4df']
  ];
  function band(value) {
    if (value === null) return 5;
    if (value === 0) return 0;
    return Math.min(4, 1+Math.floor(value/200));
  }
  function supports(id) {return id === 'nrcs_snotel_daily_swe' || id === 'nohrsc_snodas_daily_swe';}
  function render(example, el) {
    const {grid, station, watershed} = example;
    const height = grid.values.length, width = grid.values[0].length;
    const middleLat = grid.north - height*grid.dy/2;
    const cw = 480/width, ch = cw * grid.dy / (grid.dx*Math.cos(middleLat*Math.PI/180));
    const toX = lon => (lon-grid.west)/grid.dx*cw, toY = lat => (grid.north-lat)/grid.dy*ch;
    const stationCol = Math.floor(toX(station.lon)/cw), stationRow = Math.floor(toY(station.lat)/ch);
    let row = stationRow, col = stationCol;
    const svg = (tag, attrs) => {
      const element = document.createElementNS('http://www.w3.org/2000/svg',tag);
      for (const [key,value] of Object.entries(attrs)) element.setAttribute(key,value);
      return element;
    };
    const drawing = svg('svg',{viewBox:'0 0 480 '+height*ch,role:'img',
      'aria-label':'North-up SWE map with native SNODAS cells, the USGS HUC12 boundary, and the Brundage Reservoir SNOTEL station.'});
    const hatchId = 'swe-nodata-'+(++nextMap);
    const defs = svg('defs',{}), pattern = svg('pattern',{id:hatchId,width:7,height:7,patternUnits:'userSpaceOnUse'});
    pattern.append(svg('rect',{width:7,height:7,fill:bands[5][1]}),svg('path',{d:'M-1 1l2 -2M0 7l7 -7M6 8l2 -2',stroke:'#717874','stroke-width':1.6}));
    defs.append(pattern); drawing.append(defs);
    const cells = bands.map(() => []);
    grid.values.forEach((values,r) => values.forEach((value,c) => {
      cells[band(value)].push('M'+(c*cw)+' '+(r*ch)+'h'+cw+'v'+ch+'h-'+cw+'Z');
    }));
    cells.forEach((parts,i) => drawing.append(svg('path',{d:parts.join(' '),fill:i===5?'url(#'+hatchId+')':bands[i][1],
      stroke:'#fff','stroke-opacity':0.36,'stroke-width':0.5,'shape-rendering':'crispEdges'})));
    const outline = watershed.rings.map(ring => ring.map(([lon,lat],i) =>
      (i?'L':'M')+toX(lon).toFixed(2)+' '+toY(lat).toFixed(2)).join('')+'Z').join('');
    for (const [color,weight] of [['#fff',5],['#743e23',2.8]]) {
      drawing.append(svg('path',{d:outline,fill:'none',stroke:color,'stroke-width':weight,'stroke-linejoin':'round'}));
    }
    const selected = svg('rect',{class:'swe-selected',width:cw,height:ch,fill:'none',stroke:'#152a32','stroke-width':3});
    const inner = svg('rect',{width:cw,height:ch,fill:'none',stroke:'white','stroke-width':1,'stroke-dasharray':'3 2'});
    drawing.append(selected,inner,svg('circle',{cx:toX(station.lon),cy:toY(station.lat),r:4.8,fill:'#222a2a',stroke:'white','stroke-width':2}));
    const valueText = el('strong',{class:'swe-reading'}), position = el('span',{class:'swe-position'});
    const result = el('div',{class:'swe-inspected','aria-live':'polite','aria-atomic':'true'},valueText,position);
    function select(r,c) {
      row = Math.max(0,Math.min(height-1,r)); col = Math.max(0,Math.min(width-1,c));
      for (const box of [selected,inner]) {box.setAttribute('x',col*cw);box.setAttribute('y',row*ch);}
      const value = grid.values[row][col];
      valueText.textContent = value === null ? 'No data' : value+' mm';
      position.textContent = (row===stationRow && col===stationCol?'Cell containing the station':'Selected grid cell')+
        ' · row '+(grid.row+row)+', col '+(grid.col+col)+' (zero-based)';
      result.title = 'Cell center · '+(grid.north-(row+.5)*grid.dy).toFixed(5)+'°, '+(grid.west+(col+.5)*grid.dx).toFixed(5)+'°';
    }
    const directions = {North:[-1,0,'↑'],West:[0,-1,'←'],East:[0,1,'→'],South:[1,0,'↓']};
    const buttons = Object.entries(directions).map(([name,[dr,dc,arrow]]) => {
      const control = el('button',{class:'swe-step',type:'button','aria-label':'Inspect cell '+name.toLowerCase(),title:name},arrow);
      control.addEventListener('click',()=>select(row+dr,col+dc));return control;
    });
    const reset = el('button',{class:'btn small',type:'button'},'Station cell');
    reset.addEventListener('click',()=>select(stationRow,stationCol));
    drawing.addEventListener('click',event => {
      const pointer = drawing.createSVGPoint(); pointer.x=event.clientX;pointer.y=event.clientY;
      const local = pointer.matrixTransform(drawing.getScreenCTM().inverse());
      select(Math.floor(local.y/ch),Math.floor(local.x/cw));
    });
    select(row,col);
    const legend = el('ul',{class:'swe-legend','aria-label':'SNODAS cell colors, millimeters of water equivalent'},
      ...bands.map(([label,color],i)=>el('li',{},el('i',{'aria-hidden':'true',class:i===5?'swe-hatch':'',style:'background-color:'+color}),label)));
    const source = (url,label) => el('a',{href:url,target:'_blank',rel:'noopener noreferrer'},label);
    return el('figure',{class:'swe-example'},
      el('figcaption',{},el('h3',{},'Snow water equivalent at Brundage Reservoir'),
        el('p',{},'April 1, 2024 · '+watershed.name+', Idaho · HUC12 '+watershed.code)),
      el('div',{class:'swe-layout'},
        el('div',{},el('div',{class:'swe-map'},drawing,el('span',{class:'swe-north','aria-hidden':'true'},'↑ N')),
          el('div',{class:'swe-map-key'},el('span',{class:'swe-line'},'HUC12 boundary'),el('span',{class:'swe-dot'},'SNOTEL station'))),
        el('div',{class:'swe-inspector'},
          el('h4',{},'SNODAS grid · 06:00 UTC'),result,
          el('p',{},'Select a cell on the map or move one cell at a time.'),
          el('div',{class:'swe-controls'},...buttons,reset),
          el('h4',{},'Grid SWE (mm)'),legend,
          el('h4',{},'SNOTEL · daily station reading'),
          el('strong',{class:'swe-reading'},station.inches.toFixed(1)+' in ('+(station.inches*25.4).toFixed(1)+' mm)'),
          el('p',{},station.name+' · '+station.id))),
      el('p',{class:'swe-caption'},'The station measures one location on its reporting day. SNODAS estimates SWE across each cell at its valid time. Cells extend across the watershed boundary.'),
      el('div',{class:'swe-sources'},source(watershed.url,'USGS boundary'),source(station.url,'NRCS reading'),
        source('https://doi.org/10.7265/N5TB14TC','NOHRSC / NSIDC G02158 v1'),source(grid.url,'April 1 grid')));
  }
  const api = {supports,render,band};
  root.SnowMap = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
