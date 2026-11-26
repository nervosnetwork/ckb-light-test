// Native Mocha has a global forbid-pending switch, but only these two cases are on hold.
const allowedPending = new Set(["LC-STORE-006", "LC-STORE-007"]);
const caseIds = test => [...new Set(test.fullTitle().match(/\bLC-[A-Z][A-Z0-9-]*-\d+\b/g) || [])];

module.exports = {
  allowedPending,
  caseIds,
  mochaHooks: {
    afterAll() {
      // Registration catches static .skip; also reject an unexpected runtime this.skip().
      this.test.parent.eachTest(test => {
        if (test.state !== "pending") return;
        const ids = caseIds(test);
        if (ids.length !== 1 || !allowedPending.has(ids[0])) {
          throw new Error(`Unexpected pending test: ${test.fullTitle()}`);
        }
      });
    },
  },
};
