/**
 * Just enough command-line parsing for siq: nested commands, positional
 * arguments (required, optional, variadic), boolean / valued / variadic /
 * negatable options with defaults, and generated --help. The API mirrors the
 * small part of commander that siq used, so commands read the same.
 */

interface OptionSpec {
  short?: string;
  long: string;
  /** camelCase key in opts(). */
  key: string;
  value?: { name: string; variadic: boolean };
  negate: boolean;
  description: string;
  defaultValue?: unknown;
}

interface ArgSpec {
  name: string;
  required: boolean;
  variadic: boolean;
  description?: string;
}

const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

export class Option {
  readonly spec: OptionSpec;

  constructor(flags: string, description = '', defaultValue?: unknown) {
    const m = /^(?:-([a-zA-Z]),\s*)?--([a-z0-9-]+)(?:\s+[<[]([a-z0-9-]+)(\.\.\.)?[>\]])?$/i.exec(flags.trim());
    if (!m) throw new Error(`bad option flags "${flags}"`);
    const negate = m[2]!.startsWith('no-');
    const long = m[2]!;
    this.spec = {
      short: m[1],
      long,
      key: camel(negate ? long.slice(3) : long),
      value: m[3] ? { name: m[3], variadic: !!m[4] } : undefined,
      negate,
      description,
      // A --no-x option means x defaults to true.
      defaultValue: negate && defaultValue === undefined ? true : defaultValue,
    };
  }
}

export class CommandError extends Error {}

type Action = (...args: never[]) => unknown;

export class Command {
  private _name = '';
  private _description = '';
  private _version?: string;
  private options: OptionSpec[] = [];
  private args: ArgSpec[] = [];
  private commands: Command[] = [];
  private defaultCommand?: Command;
  private _action?: Action;
  private parent?: Command;
  private values: Record<string, unknown> = {};

  name(n: string): this {
    this._name = n;
    return this;
  }

  description(d: string): this {
    this._description = d;
    return this;
  }

  version(v: string): this {
    this._version = v;
    return this;
  }

  option(flags: string, description = '', defaultValue?: unknown): this {
    return this.addOption(new Option(flags, description, defaultValue));
  }

  addOption(o: Option): this {
    this.options.push(o.spec);
    return this;
  }

  argument(spec: string, description?: string): this {
    const m = /^([<[])([a-z0-9-]+)(\.\.\.)?[>\]]$/i.exec(spec);
    if (!m) throw new Error(`bad argument "${spec}"`);
    this.args.push({ name: m[2]!, required: m[1] === '<', variadic: !!m[3], description });
    return this;
  }

  command(name: string, opts: { isDefault?: boolean } = {}): Command {
    const sub = new Command().name(name);
    sub.parent = this;
    this.commands.push(sub);
    if (opts.isDefault) this.defaultCommand = sub;
    return sub;
  }

  action(fn: Action): this {
    this._action = fn;
    return this;
  }

  opts<T = Record<string, unknown>>(): T {
    return this.values as T;
  }

  private path(): string {
    return this.parent ? `${this.parent.path()} ${this._name}` : this._name;
  }

  /** Options visible at this level: own ones plus every ancestor's. */
  private findOption(token: string): { owner: Command; spec: OptionSpec } | undefined {
    for (let c: Command | undefined = this; c; c = c.parent) {
      const spec = c.options.find((o) => (token.startsWith('--') ? o.long === token.slice(2) : o.short === token.slice(1)));
      if (spec) return { owner: c, spec };
    }
    return undefined;
  }

  help(): string {
    const usage = [this.path()];
    if (this.options.length || this._version) usage.push('[options]');
    if (this.commands.length) usage.push('<command>');
    for (const a of this.args) usage.push(a.required ? `<${a.name}${a.variadic ? '...' : ''}>` : `[${a.name}${a.variadic ? '...' : ''}]`);
    const lines = [`Usage: ${usage.join(' ')}`, ''];
    if (this._description) lines.push(this._description, '');
    const table = (rows: Array<[string, string]>) => {
      const w = Math.max(...rows.map(([l]) => l.length));
      return rows.map(([l, r]) => `  ${l.padEnd(w)}  ${r}`.trimEnd());
    };
    const flagText = (o: OptionSpec) => `${o.short ? `-${o.short}, ` : ''}--${o.long}${o.value ? ` <${o.value.name}${o.value.variadic ? '...' : ''}>` : ''}`;
    const describe = (o: OptionSpec) => (o.defaultValue !== undefined && !o.negate && o.defaultValue !== false ? `${o.description} (default: ${JSON.stringify(o.defaultValue)})` : o.description);
    const argRows = this.args.filter((a) => a.description).map((a): [string, string] => [a.name, a.description!]);
    if (argRows.length) lines.push('Arguments:', ...table(argRows), '');
    const optRows: Array<[string, string]> = this.options.map((o) => [flagText(o), describe(o)]);
    if (this._version) optRows.push(['-V, --version', 'print the version']);
    optRows.push(['-h, --help', 'show help']);
    lines.push('Options:', ...table(optRows), '');
    if (this.commands.length) lines.push('Commands:', ...table(this.commands.map((c) => [c._name + (c === this.defaultCommand ? ' (default)' : ''), c._description])), '');
    return lines.join('\n');
  }

  /** Parse argv (without node and script) and run the matching action. */
  async parseAsync(argv: string[] = process.argv.slice(2)): Promise<void> {
    try {
      await this.run(argv);
    } catch (err) {
      if (err instanceof CommandError) {
        console.error(`error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  }

  private async run(argv: string[]): Promise<void> {
    for (const o of this.options) if (!(o.key in this.values) && o.defaultValue !== undefined) this.values[o.key] = o.defaultValue;
    const positionals: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const tok = argv[i]!;
      if (tok === '--') {
        positionals.push(...argv.slice(i + 1));
        break;
      }
      if (tok === '-h' || tok === '--help') {
        process.stdout.write(this.help() + '\n');
        return;
      }
      if (this._version && (tok === '-V' || tok === '--version')) {
        console.log(this._version);
        return;
      }
      if (!tok.startsWith('-') || tok === '-') {
        const sub = !positionals.length && this.commands.find((c) => c._name === tok);
        if (sub) return sub.run(argv.slice(i + 1));
        positionals.push(tok);
        continue;
      }
      const eq = tok.startsWith('--') ? tok.indexOf('=') : -1;
      const flag = eq > 0 ? tok.slice(0, eq) : tok;
      const found = this.findOption(flag);
      if (!found) throw new CommandError(`unknown option '${flag}'\n(run '${this.path()} --help' for usage)`);
      const { owner, spec } = found;
      if (!spec.value) {
        if (eq > 0) throw new CommandError(`option '${flag}' takes no value`);
        owner.values[spec.key] = !spec.negate;
        continue;
      }
      const vals: string[] = [];
      if (eq > 0) vals.push(tok.slice(eq + 1));
      else {
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith('-') && next !== '-')) throw new CommandError(`option '${flag}' needs a value`);
        vals.push(next);
        i++;
      }
      if (spec.value.variadic) {
        while (eq < 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('-')) vals.push(argv[++i]!);
        owner.values[spec.key] = [...((owner.values[spec.key] as string[] | undefined) ?? []), ...vals];
      } else owner.values[spec.key] = vals[0];
    }

    if (!positionals.length && this.defaultCommand) return this.defaultCommand.run([]);
    if (this.commands.length && !this._action) {
      if (positionals.length) throw new CommandError(`unknown command '${positionals[0]}'\n(run '${this.path()} --help' for usage)`);
      process.stdout.write(this.help() + '\n');
      process.exitCode = 1;
      return;
    }
    const args: unknown[] = [];
    let rest = positionals;
    for (const a of this.args) {
      if (a.variadic) {
        args.push(rest);
        rest = [];
      } else {
        if (a.required && !rest.length) throw new CommandError(`missing required argument '${a.name}'`);
        args.push(rest[0]);
        rest = rest.slice(1);
      }
    }
    if (rest.length) throw new CommandError(`too many arguments for '${this.path()}'`);
    await (this._action as ((...a: unknown[]) => unknown) | undefined)?.(...args, this.values, this);
  }
}
