import readline from 'node:readline';
import { Writable } from 'node:stream';
import { hashPassword } from '../api/auth.js';
import { Store } from '../state/store.js';

/**
 * Operator account management for the console login.
 *
 *   npm run user -w server -- add <name>      (prompts for password, echo hidden)
 *   npm run user -w server -- remove <name>
 *   npm run user -w server -- list
 *   [--db data/ptt.db]
 */

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    let muted = false;
    const mutable = new Writable({
      write(chunk, _enc, cb) {
        if (!muted) process.stdout.write(chunk);
        cb();
      },
    });
    const rl = readline.createInterface({ input: process.stdin, output: mutable, terminal: true });
    mutable.write(question);
    muted = true;
    rl.question('', (answer) => {
      muted = false;
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const store = new Store(arg('db', 'data/ptt.db')!);
const [, , command, username] = process.argv;

switch (command) {
  case 'add': {
    if (!username) usage();
    const pw = await promptHidden(`Password for ${username}: `);
    if (pw.length < 8) {
      console.error('Password must be at least 8 characters.');
      process.exit(1);
    }
    const confirm = await promptHidden('Confirm password: ');
    if (pw !== confirm) {
      console.error('Passwords do not match.');
      process.exit(1);
    }
    store.addUser(username, hashPassword(pw));
    console.log(`User "${username}" saved.`);
    break;
  }
  case 'remove': {
    if (!username) usage();
    console.log(store.deleteUser(username) ? `User "${username}" removed.` : `No such user "${username}".`);
    break;
  }
  case 'list': {
    const users = store.listUsers();
    if (users.length === 0) console.log('No users. Create one with: npm run user -w server -- add <name>');
    for (const u of users) console.log(`${u.username}  (created ${new Date(u.created_at_ms).toISOString()})`);
    break;
  }
  default:
    usage();
}
store.close();

function usage(): never {
  console.error('Usage: npm run user -w server -- (add <name> | remove <name> | list) [--db data/ptt.db]');
  process.exit(1);
}
