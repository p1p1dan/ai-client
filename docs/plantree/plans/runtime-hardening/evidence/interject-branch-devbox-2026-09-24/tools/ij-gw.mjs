/** Gateway control: `node ij-gw.mjs start [gateway args…]` | `node ij-gw.mjs stop` | `node ij-gw.mjs tail [n]`. */
import { gwLines, startGateway, stopGatewaySync } from './ij-lib.mjs';

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'start') console.log(JSON.stringify(await startGateway(rest)));
else if (cmd === 'stop') console.log('stopped pid', stopGatewaySync());
else if (cmd === 'tail') {
  const n = Number(rest[0] ?? 10);
  const { lines, total } = gwLines(0);
  console.log(`total=${total}`);
  for (const l of lines.slice(-n)) console.log(JSON.stringify(l).slice(0, 600));
}
