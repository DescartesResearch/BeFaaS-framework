#!/usr/bin/env node

const fs = require('fs');
const crypto = require('crypto');

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    count: 9000,
    output: 'users.csv',
    algorithm: 'argon2id-eddsa'
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--count':
      case '-n':
        config.count = parseInt(args[++i], 10);
        break;
      case '--output':
      case '-o':
        config.output = args[++i];
        break;
      case '--algorithm':
        config.algorithm = args[++i];
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
    }
  }

  const validAlgorithms = ['argon2id-eddsa', 'bcrypt-hs256'];
  if (!validAlgorithms.includes(config.algorithm)) {
    console.error(`Error: Invalid algorithm '${config.algorithm}'. Must be one of: ${validAlgorithms.join(', ')}`);
    process.exit(1);
  }

  return config;
}

function printUsage() {
  console.log(`
Usage: node generateUsers.js [options]

Options:
  --count, -n       Number of users to generate (default: 9000)
  --output, -o      Output file path (default: users.csv)
  --algorithm       Hash algorithm: argon2id-eddsa or bcrypt-hs256 (default: argon2id-eddsa)
  --help, -h        Show help

Examples:
  node generateUsers.js
  node generateUsers.js --count 1000 --output test-users.csv
  node generateUsers.js --algorithm bcrypt-hs256
  node generateUsers.js -n 5000 --algorithm argon2id-eddsa
`);
}

function generateRandomString(length, chars) {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateUsername() {
  const length = Math.floor(Math.random() * 8) + 5; // 5-12 chars
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return generateRandomString(length, chars);
}

function generatePassword() {
  const lowercase = 'abcdefghijklmnopqrstuvwxyz';
  const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const numbers = '0123456789';
  const allChars = lowercase + uppercase + numbers;

  // Ensure at least one of each required type
  let password = '';
  password += lowercase.charAt(Math.floor(Math.random() * lowercase.length));
  password += uppercase.charAt(Math.floor(Math.random() * uppercase.length));
  password += numbers.charAt(Math.floor(Math.random() * numbers.length));

  // Fill remaining length (8-12 total)
  const remainingLength = Math.floor(Math.random() * 5) + 5;
  password += generateRandomString(remainingLength, allChars);

  // Shuffle password
  return password.split('').sort(() => Math.random() - 0.5).join('');
}

// Argon2id parameters (must match register.js)
const ARGON2_MEMORY = 65536;
const ARGON2_ITERATIONS = 3;
const ARGON2_PARALLELISM = 1;
const ARGON2_HASH_LENGTH = 32;

// Bcrypt parameters (must match register.js)
const BCRYPT_ROUNDS = 10;

async function hashPasswordsBatch(passwords, algorithm, onProgress) {
  const hashes = [];
  const batchSize = 100;

  for (let i = 0; i < passwords.length; i += batchSize) {
    const batch = passwords.slice(i, i + batchSize);
    let batchHashes;

    if (algorithm === 'bcrypt-hs256') {
      const bcrypt = require('bcryptjs');
      batchHashes = await Promise.all(
        batch.map(pwd => bcrypt.hash(pwd, BCRYPT_ROUNDS))
      );
    } else {
      const { argon2id } = require('hash-wasm');
      batchHashes = await Promise.all(
        batch.map(async (pwd) => {
          const salt = new Uint8Array(16);
          crypto.randomFillSync(salt);
          return argon2id({
            password: pwd,
            salt,
            parallelism: ARGON2_PARALLELISM,
            iterations: ARGON2_ITERATIONS,
            memorySize: ARGON2_MEMORY,
            hashLength: ARGON2_HASH_LENGTH,
            outputType: 'encoded'
          });
        })
      );
    }

    hashes.push(...batchHashes);

    if (onProgress) {
      onProgress(Math.min(i + batchSize, passwords.length), passwords.length);
    }
  }

  return hashes;
}

async function generateUsersCSV(config) {
  const hashName = config.algorithm === 'bcrypt-hs256' ? 'bcrypt' : 'argon2id';
  console.log('='.repeat(60));
  console.log(`  Generating Users with ${hashName} Hashes`);
  console.log('='.repeat(60));
  console.log(`\nCount: ${config.count}`);
  console.log(`Algorithm: ${config.algorithm}`);
  console.log(`Output: ${config.output}`);

  console.log('\nGenerating usernames...');
  const usernames = new Set();
  while (usernames.size < config.count) {
    usernames.add(generateUsername());
  }

  console.log('Generating passwords...');
  const users = Array.from(usernames).map(userName => ({
    userName,
    password: generatePassword()
  }));

  console.log(`Computing ${hashName} hashes...`);
  const startTime = Date.now();

  const passwords = users.map(u => u.password);
  const hashes = await hashPasswordsBatch(passwords, config.algorithm, (current, total) => {
    const percent = Math.round(current / total * 100);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    process.stdout.write(`\rProgress: ${current}/${total} (${percent}%) - ${elapsed}s`);
  });

  console.log('\n');

  users.forEach((user, i) => {
    user.passwordHash = hashes[i];
  });

  console.log('Writing CSV...');
  const csvRows = ['userName,password,passwordHash'];
  users.forEach(user => {
    csvRows.push(`${user.userName},${user.password},${user.passwordHash}`);
  });

  fs.writeFileSync(config.output, csvRows.join('\n'));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nCompleted in ${elapsed}s`);
  console.log(`Created ${config.output} with ${config.count} users`);
  console.log('='.repeat(60));
}

const config = parseArgs();

generateUsersCSV(config).catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});