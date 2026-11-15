// Hand-rolled flag parser for the two subcommands; zero dependencies on purpose.
// --json, --status take a value; everything else in argv is a positional.
export function parseFlags(argv) {
  const flags = new Map();
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags.set(name, true); // boolean flag, no value
      } else {
        flags.set(name, next);
        i++;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}
