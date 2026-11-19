const test = require('node:test');
const assert = require('node:assert/strict');
const chart = require('../src/observation-chart.js');
const window = {start:'1982-01-01',end:'1982-01-02'};
const day = (date,value,flags={}) => ({time:date,value,flags});
for (const key of ['PRCP','SNOW']) {
  test(key+' distinguishes a measured zero from a missing amount presumed zero', () => {
    const points=[day(window.start,0),day(window.end,0,{measurementFlag:'P'})];
    const m=chart.model({key,cadenceMs:86400000,points},window,'ghcn_daily');
    assert.equal(m.numeric.length,2);
    assert.equal(m.presumedZeroCount,1);
    assert.equal(m.sum,0);
    assert.equal(m.lowerBound,true);
    assert.equal(m.complete,false);
    assert.equal(m.peak.time,window.start);
    const pOnly=chart.model({key,cadenceMs:86400000,points:[points[1]]},{start:window.end,end:window.end},'ghcn_daily');
    assert.equal(pOnly.sum,null);
    assert.equal(pOnly.peak,null);
    assert.equal(pOnly.absent,0);
    assert.equal(points[1].value,0);
    assert.deepEqual(points[1].flags,{measurementFlag:'P'});
  });
}
test('a presumed amount with a QC failure cannot become either displayed maximum',()=>{
  const points=[day(window.start,3),day(window.end,0,{measurementFlag:'P',qualityFlag:'X'})];
  const m=chart.model({key:'PRCP',cadenceMs:86400000,points},window,'ghcn_daily');
  assert.equal(m.failedCount,1);assert.equal(m.flaggedPeak,null);
  assert.equal(m.sum,3);assert.equal(m.peak.value,3);assert.equal(m.lowerBound,true);
});
