const test = require('node:test');
const assert = require('node:assert/strict');
const geometry = require('../src/geometry.js');
require('../src/screening.js');
const state = require('../src/project-state.js');
const {project,productIds} = require('./fixtures/inventory-v02.json');
const hazards = require('../data/hazard_groups.json').map(group=>group.id);
const parse = value=>state.parse(JSON.stringify(value),productIds,hazards);

test('project size limits apply to UTF-8 content while allowing older area-file indentation',()=>{
  assert.equal(state.serialize(project),JSON.stringify(project,null,2));
  const query={mode:'area',bufferKm:0,areaName:'Test area',start:project.query.start,end:project.query.end,geometry:geometry.rectangle(-78,38,-77,39)};
  const legacy=JSON.stringify({...project,query},null,2).padEnd(state.MAX_BYTES+1);
  assert.deepEqual(state.parse(legacy,productIds,hazards).query.geometry,query.geometry);
  const excess={...project,query,unrelated:'é'.repeat(state.MAX_BYTES/2)};
  assert.throws(()=>state.serialize(excess),/8 MB/);
  assert.throws(()=>state.parse(JSON.stringify(excess),productIds,hazards),/8 MB/);
  assert.throws(()=>state.parse(legacy.padEnd(state.MAX_FORMATTED_BYTES+1),productIds,hazards),/16 MB/);
});

test('published point projects round-trip through links and preserve the selected record and hazard',()=>{
  const normalized = parse(project);
  const encoded = state.fragment(normalized).split('?project=')[1];
  assert.deepEqual(state.parse(decodeURIComponent(encoded),productIds,hazards),normalized);
  assert.deepEqual(normalized.query,project.query);
  assert.equal(normalized.selectedId,project.selectedId);
  assert.equal(normalized.hazard,project.hazard);
  assert.equal(parse({...project,hazard:undefined}).hazard,'');
  assert.notEqual(state.key(parse({...project,hazard:null})),state.key(parse({...project,hazard:''})));
});

test('custom date-line polygons reopen with their original footprint and qualified source attribution',()=>{
  const polygon=geometry.rectangle(170,-20,-170,-10);
  const query={mode:'area',areaName:'Fiji',geometry:polygon,bufferKm:0,start:project.query.start,end:project.query.end,
    areaSource:{url:'https://example.test/boundary'}};
  const saved=parse({...project,query});
  assert.deepEqual(saved.query.geometry,polygon);
  assert.equal(saved.query.areaSource.kind,'project-link');
  assert.match(saved.query.areaSource.note,/not verified/);
});

test('legacy project validation rejects invalid edits and preserves only supported shared inputs',()=>{
  assert.throws(()=>parse({...project,query:{...project.query,lat:91}}));
  assert.throws(()=>parse({...project,query:{...project.query,start:'2020-02-30'}}));
  assert.throws(()=>parse({...project,selectedId:'unknown-record'}));
  assert.throws(()=>state.fragment({...project,query:{...project.query,areaName:'x'.repeat(15000)}}),/project file/);
  assert.throws(()=>state.parse(' '.repeat(state.MAX_BYTES+1),productIds,hazards),/8 MB/);
  assert.deepEqual(parse({...project,rawResponse:'example',query:{...project.query,unrelated:'example'}}),parse(project));
});
