const {test}=require('node:test');
const assert=require('node:assert/strict');
const grdc=require('../src/grdc-catalogue.js'),geometry=require('../src/geometry.js');
const file=(content,name='catalogue.csv')=>new File([content],name);

test('GRDC catalogue keeps GRDC numbers, windows, missing values, quoted names and report-only geography',async()=>{
  const data=await grdc.read(file('station_no;station_id;station_name;station_latitude;station_longitude;d_start;d_end;m_start;m_end\r\n001;771;"Name; two";0;180;2000;2002;2010;2012\r\n002;772;Nearby;0;-179.8;1998;2001;;\r\n003;773;Unknown;0;179.95;-999;;;\r\n004;774;Invalid;;-179.95;2010;2011;;\r\n005;775;Far;10;45;;;;'));
  assert.equal(data.skipped,1);assert.equal(data.stations.length,4);
  assert.equal(data.stations[0].name,'Name; two');
  const q={mode:'point',lat:0,lon:180,radiusKm:30,start:'2012-03-01',end:'2012-03-15'};
  const result=grdc.match(data,q,geometry);
  assert.deepEqual(result.map(s=>[s.id,s.dateState]),[['001','Year ranges overlap'],['003','Check dates'],['002','Outside project years']]);
  assert.ok(result[2].distanceKm>22&&result[2].distanceKm<23);
  assert.deepEqual(grdc.match(data,{...q,mode:'area',geometry:geometry.rectangle(179.9,-1,-179.9,1),bufferKm:0},geometry).map(s=>s.id),['001','003']);
  assert.equal(grdc.match(data,{...q,start:'2005-01-01',end:'2005-12-31'},geometry).find(s=>s.id==='001').dateState,'Outside project years');
});

test('GRDC station-map interval classes disclose unknown coverage within the band',async()=>{
  const layer=(kind,ids)=>({method:'addCircleMarkers',args:[[0],[10],3,null,kind,{fillColor:['#aaa']},null,null,ids]});
  const calls=[{method:'addLegend',args:[{title:'Time series end [years]',colors:['#aaa'],labels:['1980 &ndash; 2000']}]},layer('All',['GRDC Station Nr: 1234567']),layer('Daily',['GRDC Station Nr: 1234567'])];
  const script='<scr'+'ipt type="application/json">'+JSON.stringify({x:{calls}})+'</scr'+'ipt>';
  const data=await grdc.read(file('<html>'+script+script+'</html>','map.html'));
  assert.equal(data.stations.length,1);
  const q={mode:'point',lat:0,lon:10,radiusKm:0,start:'1990-01-01',end:'1990-12-31'};
  assert.equal(grdc.match(data,q,geometry)[0].dateState,'Check dates');
  assert.equal(grdc.match(data,{...q,start:'2001-01-01',end:'2001-12-31'},geometry)[0].dateState,'Outside project years');
  await assert.rejects(grdc.read(file('<html>plain map</html>','map.html')),/GRDC Station Maps/);
  await assert.rejects(grdc.read(file('station_no,lat,long\n1,,0')),/No valid GRDC stations/);
});
