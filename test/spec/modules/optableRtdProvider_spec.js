import {
  parseConfig,
  defaultHandleRtd,
  getBidRequestData,
  getTargetingData,
  optableSubmodule,
} from 'modules/optableRtdProvider';

describe('Optable RTD Submodule', function () {
  describe('parseConfig', function () {
    it('parses valid config correctly', function () {
      const config = {
        params: {
          adserverTargeting: true,
          handleRtd: () => {}
        }
      };
      expect(parseConfig(config)).to.deep.equal({
        adserverTargeting: true,
        handleRtd: config.params.handleRtd,
      });
    });

    it('defaults adserverTargeting to true if missing', function () {
      expect(parseConfig({ params: {} }).adserverTargeting).to.be.true;
    });

    it('throws an error if handleRtd is not a function', function () {
      expect(() => parseConfig({ params: { handleRtd: 'notAFunction' } })).to.throw();
    });
  });

  describe('defaultHandleRtd', function () {
    let sandbox, reqBidsConfigObj, mergeFn;

    beforeEach(() => {
      sandbox = sinon.createSandbox();
      reqBidsConfigObj = { ortb2Fragments: { global: {} } };
      mergeFn = sinon.spy();
      window.optable = {
        rtd: {
          targeting: sandbox.stub(),
          targetingFromCache: sandbox.stub(),
        },
      };
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('merges valid targeting data into the global ORTB2 object', async function () {
      const targetingData = { ortb2: { user: { ext: { optable: 'testData' } } } };
      window.optable.rtd.targetingFromCache.returns(targetingData);
      window.optable.rtd.targeting.resolves(targetingData);

      await defaultHandleRtd(reqBidsConfigObj, {}, mergeFn);
      expect(mergeFn.calledWith(reqBidsConfigObj.ortb2Fragments.global, targetingData.ortb2)).to.be.true;
    });

    it('does nothing if targeting data is missing the ortb2 property', async function () {
      window.optable.rtd.targetingFromCache.returns({});
      window.optable.rtd.targeting.resolves({});

      await defaultHandleRtd(reqBidsConfigObj, {}, mergeFn);
      expect(mergeFn.called).to.be.false;
    });

    it('uses targeting data from cache if available', async function () {
      const targetingData = { ortb2: { user: { ext: { optable: 'testData' } } } };
      window.optable.rtd.targetingFromCache.returns(targetingData);

      await defaultHandleRtd(reqBidsConfigObj, {}, mergeFn);
      expect(mergeFn.calledWith(reqBidsConfigObj.ortb2Fragments.global, targetingData.ortb2)).to.be.true;
    });

    it("doesn't call targeting function if no data is found in cache", async function () {
      const targetingData = { ortb2: { user: { ext: { optable: 'testData' } } } };
      window.optable.rtd.targetingFromCache.returns(null);
      window.optable.rtd.targeting.resolves(targetingData);

      await defaultHandleRtd(reqBidsConfigObj, {}, mergeFn);
      expect(mergeFn.calledWith(reqBidsConfigObj.ortb2Fragments.global, targetingData.ortb2)).to.be.false;
      expect(window.optable.rtd.targeting.called).to.be.false;
    });
  });

  describe('getBidRequestData', function () {
    let sandbox, reqBidsConfigObj, callback, moduleConfig;

    beforeEach(() => {
      sandbox = sinon.createSandbox();
      reqBidsConfigObj = { ortb2Fragments: { global: {} } };
      callback = sinon.spy();
      moduleConfig = { params: {} };

      sandbox.stub(window, 'optable').value({ cmd: [] });
      sandbox.stub(window.document, 'head');
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('uses existing Optable instance', function () {
      getBidRequestData(reqBidsConfigObj, callback, moduleConfig, {});
      expect(window.optable.cmd.length).to.equal(1);
    });

    it('calls callback when assuming the bundle is present', function (done) {
      getBidRequestData(reqBidsConfigObj, callback, moduleConfig, {});

      // Check that the function is queued
      expect(window.optable.cmd.length).to.equal(1);
      // Manually trigger the queued function
      window.optable.cmd[0]();

      setTimeout(() => {
        expect(callback.calledOnce).to.be.true;
        done();
      }, 50);
    });

    it('getBidRequestData catches error and executes callback handleRtd throws an error', function (done) {
      moduleConfig.params.handleRtd = () => {
        throw new Error('Test error');
      };

      getBidRequestData(reqBidsConfigObj, callback, moduleConfig, {});

      expect(window.optable.cmd.length).to.equal(1);
      window.optable.cmd[0]();

      setTimeout(() => {
        expect(callback.calledOnce).to.be.true;
        done();
      }, 50);
    });

    it('getBidRequestData catches error and executes callback when something goes wrong', function (done) {
      moduleConfig.params.handleRtd = 'not a function';

      getBidRequestData(reqBidsConfigObj, callback, moduleConfig, {});

      expect(window.optable.cmd.length).to.equal(0);

      setTimeout(() => {
        expect(callback.calledOnce).to.be.true;
        done();
      }, 50);
    });

    it("doesn't fail when optable is not available", function () {
      delete window.optable;
      getBidRequestData(reqBidsConfigObj, callback, moduleConfig, {});

      expect(window.optable.cmd.length).to.equal(1);
    });
  });

  describe('getTargetingData', function () {
    let sandbox, moduleConfig;

    beforeEach(() => {
      sandbox = sinon.createSandbox();
      moduleConfig = { params: { adserverTargeting: true } };
      window.optable = { rtd: { targetingKeyValuesFromCache: sandbox.stub().returns({ key1: 'value1' }) } };
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('returns correct targeting data when Optable data is available', function () {
      const result = getTargetingData(['adUnit1'], moduleConfig, {}, {});
      expect(result).to.deep.equal({ adUnit1: { key1: 'value1' } });
    });

    it('returns empty object when no Optable data is found', function () {
      window.optable.rtd.targetingKeyValuesFromCache.returns({});
      expect(getTargetingData(['adUnit1'], moduleConfig, {}, {})).to.deep.equal({});
    });

    it('returns empty object when adserverTargeting is disabled', function () {
      moduleConfig.params.adserverTargeting = false;
      expect(getTargetingData(['adUnit1'], moduleConfig, {}, {})).to.deep.equal({});
    });

    it('returns empty object when provided keys contain no data', function () {
      window.optable.rtd.targetingKeyValuesFromCache.returns({ key1: [] });
      expect(getTargetingData(['adUnit1'], moduleConfig, {}, {})).to.deep.equal({});

      window.optable.rtd.targetingKeyValuesFromCache.returns({ key1: [], key2: [], key3: [] });
      expect(getTargetingData(['adUnit1'], moduleConfig, {}, {})).to.deep.equal({});
    });
  });

  describe('init', function () {
    it('initializes Optable RTD module', function () {
      expect(optableSubmodule.init()).to.be.true;
    });
  });
});
