// NETGN.R32: DirectPlay multiplayer. Out of scope: report that no network
// service providers exist, so the game's own "network play not available"
// paths run.
export class NetPlugin {
  constructor(engine) {
    this.engine = engine;
    this.name = "netgn";
    const none = () => 0;
    this.externs = {
      DPIsValidVersion: none,
      DPCheckForConnect: none,
      DPEnumProviders: none,
      DPInit: none,
      DPGetNumPlayers: none,
    };
  }
}
