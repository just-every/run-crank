/** Owner assumptions for the sample workspace, quoted through normal admission. */
export const demoUsageCost = {
  components: [
    { kind: 'orchestration', usd_per_run: '0.001', assumption: 'Owner projects orchestration for one complete run.' },
    { kind: 'connectors', usd_per_run: '0.002', assumption: 'Owner projects the destination requests for one complete run.' },
    { kind: 'models', usd_per_run: '0', assumption: 'These workflows contain no model steps.' },
    { kind: 'executors', usd_per_run: '0', assumption: 'These workflows contain no external executor steps.' },
  ],
}
