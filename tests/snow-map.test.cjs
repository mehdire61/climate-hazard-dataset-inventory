const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {band} = require('../src/snow-map.js');
const example = require('../data/brundage-swe.json');
const receipt = require('../docs/evidence/snodas/receipt.json');
const station = require('../docs/evidence/snotel/brundage-station.json')[0];
const daily = require('../docs/evidence/snotel/brundage-daily-wteq.json')[0];
const geometry = require('../src/geometry.js');

test('the native-grid map locates the provider station inside its returned HUC12', () => {
  const {grid,watershed} = example;
  assert.deepEqual([example.station.lon,example.station.lat],[station.longitude,station.latitude]);
  assert.equal(watershed.code,station.huc);
  assert.equal(geometry.classify({mode:'area',bufferKm:0,geometry:{type:'Polygon',coordinates:watershed.rings}},example.station).relation,'inside');
  const row = Math.floor((grid.north-station.latitude)/grid.dy), col=Math.floor((station.longitude-grid.west)/grid.dx);
  const cell = receipt.cells[0];
  assert.deepEqual([grid.row+row,grid.col+col,grid.values[row][col]],[cell.rowZeroBased,cell.colZeroBased,cell.sweMm]);
  assert.equal(grid.validTime,receipt.validTime);
  assert.equal(example.station.inches,daily.data[0].values.find(reading=>reading.date===example.date).value);
  assert.equal(createHash('sha256').update(JSON.stringify(grid.values)).digest('hex'),'f329a15403b207249bfb2c42daaa093f3caafab054895bba1fe7f7b1c632bc74');
});

test('snow map separates measured zero, masked cells and inclusive SWE classes', () => {
  assert.deepEqual([0,1,199,200,399,400,599,600,1200,null].map(band),[0,1,1,2,2,3,3,4,4,5]);
  assert.ok(example.grid.values.flat().includes(null) && example.grid.values.flat().includes(0));
});
