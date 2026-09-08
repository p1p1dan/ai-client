// This classifier admits a small inspection grammar, not arbitrary shell programs.
export function isExplorationCommand(command: string): boolean {
  if (/[\n\r<>`$(){}\\]/.test(command) || /(?<!&)&(?!&)/.test(command)) return false;
  const parts = command.split(/&&|\|\||[;|]/);
  return parts.every((part) => {
    const words = part.trim().match(/"[^"]*"|'[^']*'|[^\s]+/g);
    if (!words?.length) return false;
    const [name, ...args] = words.map((word) => word.replace(/^["']|["']$/g, ''));
    if (
      args.some((arg) =>
        /^(?:--output(?:=|$)|--exec(?:=|$)|--pre(?:=|$)|--pre-glob(?:=|$)|--config(?:=|$)|-i$)/.test(
          arg
        )
      )
    )
      return false;
    if (name === 'git') {
      const [verb, ...flags] = args;
      return (
        ['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'ls-tree'].includes(verb) &&
        !flags.some((flag) => /^(?:--ext-diff|--textconv|--output(?:=|$))/.test(flag))
      );
    }
    return [
      'pwd',
      'ls',
      'cat',
      'head',
      'tail',
      'wc',
      'stat',
      'which',
      'echo',
      'printf',
      'rg',
      'grep',
    ].includes(name);
  });
}
