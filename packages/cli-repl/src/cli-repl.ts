import repl, { REPLServer } from 'repl';
import util from 'util';
import read from 'read';
import { Transform } from 'stream';
import { CliServiceProvider } from 'mongosh-service-provider-server';
import { NodeOptions } from 'mongosh-transport-server';
import { compile } from 'mongosh-mapper';
import Mapper from 'mongosh-mapper';
import ShellApi from 'mongosh-shell-api';
import CliOptions from './cli-options';

const COLORS = { RED: "31", GREEN: "32", YELLOW: "33", BLUE: "34", MAGENTA: "35" };
const colorize = (color, s) => `\x1b[${color}m${s}\x1b[0m`;

/**
 * The REPL used from the terminal.
 */
class CliRepl {
  private useAntlr?: boolean;
  private serviceProvider: CliServiceProvider;
  private mapper: Mapper;
  private shellApi: ShellApi;
  private repl: REPLServer;

  /**
   * Connect to the cluster.
   *
   * @param {string} driverUrl - The driver URI.
   * @param {NodeOptions} driverOptions - The driver options.
   */
  connect(driverUri: string, driverOptions: NodeOptions): void {
    console.log('Connecting to:', driverUri);
    CliServiceProvider.connect(driverUri, driverOptions).then((serviceProvider) => {
      this.serviceProvider = serviceProvider;
      this.mapper = new Mapper(this.serviceProvider);
      this.shellApi = new ShellApi(this.mapper);
      this.start();
    });
  }

  /**
   * Instantiate the new CLI Repl.
   */
  constructor(driverUri: string, driverOptions: NodeOptions, options: CliOptions) {
    this.useAntlr = !!options.antlr;

    if (this.isPasswordMissing(driverOptions)) {
      this.requirePassword(driverUri, driverOptions);
    } else {
      this.connect(driverUri, driverOptions);
    }
  }

  /**
   * The custom evaluation function.
   *
   * @param {} originalEval - The original eval function.
   * @param {} input - The input.
   * @param {} context - The context.
   * @param {} filename - The filename.
   */
  async evaluator(originalEval: any, input: string, context: any, filename: string) {
    const argv = input.trim().split(' ');
    const cmd = argv[0];
    argv.shift();
    switch(cmd) {
      case 'use':
        return this.shellApi.use(argv[0]);
      case 'it':
        return this.shellApi.it();
      case 'help()':
        return this.shellApi.help;
      case 'var':
        this.mapper.cursorAssigned = true;
      default:
        const finalValue = await originalEval(input, context, filename);
        return await this.writer(finalValue);
    }
  }

  /**
   * The greeting for the shell.
   */
  greet(): void {
    console.log('mongosh 2.0');
  }

  /**
   * Is the password missing from the options?
   *
   * @param {NodeOptions} driverOptions - The driver options.
   *
   * @returns {boolean} If the password is missing.
   */
  isPasswordMissing(driverOptions: NodeOptions): boolean {
    return driverOptions.auth &&
      driverOptions.auth.user &&
      !driverOptions.auth.password
  }

  /**
   * Require the user to enter a password.
   *
   * @param {string} driverUrl - The driver URI.
   * @param {NodeOptions} driverOptions - The driver options.
   */
  requirePassword(driverUri: string, driverOptions: NodeOptions): void {
    const readOptions = {
      prompt: 'Enter password: ',
      silent: true,
      replace: '*'
    };
    read(readOptions, (error, password) => {
      driverOptions.auth.password = password;
      this.connect(driverUri, driverOptions);
    });
  }

  /**
   * Start the REPL.
   */
  start(): void {
    this.greet();

    this.repl = repl.start({
      prompt: `$ mongosh > `,
      ignoreUndefined: true,
      writer: this.writer
    });

    const originalEval = util.promisify(this.repl.eval);

    const customEval = async(input, context, filename, callback) => {
      try {
        let str;
        if (this.useAntlr) {
          // Eval once with execution turned off and a throwaway copy of the context
          this.mapper.checkAwait = true;
          this.mapper.awaitLoc = [];
          const copyCtx = context;// _.cloneDeep(context);
          await this.evaluator(originalEval, input, copyCtx, filename);

          // Pass the locations to a parser so that it can add 'await' if any function calls contain 'await' locations
          const syncStr = compile(input, this.mapper.awaitLoc);
          if (syncStr.trim() !== input.trim()) {
            console.log(`DEBUG: rewrote input "${input.trim()}" to "${syncStr.trim()}"`);
          }

          // Eval the rewritten string, this time for real
          this.mapper.checkAwait = false;
          str = await this.evaluator(originalEval, syncStr, context, filename);
        } else {
          str = await this.evaluator(originalEval, input, context, filename);
        }
        callback(null, str);
      } catch (err) {
        callback(err, null);
      } finally {
        this.mapper.cursorAssigned = false;
      }
    };

    // @ts-ignore
    this.repl.eval = customEval;

    this.repl.on('exit', () => {
      this.serviceProvider.close(true);
      process.exit();
    });

    Object.keys(this.shellApi)
      .filter(k => (!k.startsWith('_')))
      .forEach(k => (this.repl.context[k] = this.shellApi[k]));
    this.mapper.setCtx(this.repl.context);
  }

  /**
   * Return the pretty string for the output.
   *
   * @param {any} output - The output.
   *
   * @returns {string} The output.
   */
  writer(output: any): string {
    if (output && output.toReplString) {
      return output.toReplString();
    }
    if (typeof output === 'string') {
      return output;
    }
    return util.inspect(output, {
      showProxy: false,
      colors: true,
    });
  }
}

export default CliRepl;
