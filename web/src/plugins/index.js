// Plugins: the .R32 DLLs whose exports the scripts call as externs.
import { SmackerPlugin } from "./smacker.js";
import { RenderPlugin } from "./render.js";
import { NetPlugin } from "./netgn.js";

export function installPlugins(engine) {
  const bin = engine.bin;
  engine.plugins = [new SmackerPlugin(engine), new RenderPlugin(engine), new NetPlugin(engine)];
  const byName = new Map(engine.plugins.map((p) => [p.name, p]));
  bin.externNames.forEach((name, i) => {
    const plugin = byName.get(bin.plugins[bin.externPlugin[i]]);
    const f = plugin && plugin.externs[name];
    if (f) engine.vm.externs[i] = (vm, args) => f.apply(plugin, args) | 0;
  });
}
