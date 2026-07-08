#!/usr/bin/env node

const fs = require('fs');
const net = require('net');
const crypto = require('crypto');

const usersFile = '/workload/users.csv';
const BATCH_SIZE = 1000;

function parseRedisUrl(url) {
  const match = url.match(/redis:\/\/([^:]*):([^@]*)@([^:]+):(\d+)/);
  if (!match) {
    throw new Error(`Invalid Redis URL format: ${url}`);
  }
  return {
    username: match[1] || 'default',
    password: match[2],
    host: match[3],
    port: parseInt(match[4], 10)
  };
}

function parseUsersCSV() {
  const content = fs.readFileSync(usersFile, 'utf8');
  const lines = content.trim().split('\n');
  const header = lines[0].split(',');

  const userNameIndex = header.indexOf('userName');
  const passwordIndex = header.indexOf('password');
  const passwordHashIndex = header.indexOf('passwordHash');

  if (userNameIndex === -1 || passwordIndex === -1) {
    throw new Error('users.csv must have userName and password columns');
  }

  const hasPrecomputedHashes = passwordHashIndex !== -1;
  const users = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i].split(',');
    if (fields.length > Math.max(userNameIndex, passwordIndex)) {
      const user = {
        userName: fields[userNameIndex],
        password: fields[passwordIndex]
      };

      if (hasPrecomputedHashes && fields.length > passwordHashIndex) {
        const hash = fields.slice(passwordHashIndex).join(',').replace(/^"|"$/g, '');
        if (hash) {
          user.passwordHash = hash;
        }
      }

      users.push(user);
    }
  }

  return { users, hasPrecomputedHashes };
}

async function hashPasswordsBatch(passwords, algorithm) {
  const hashes = [];

  if (algorithm === 'bcrypt-hs256') {
    const bcrypt = require('bcryptjs');
    for (const password of passwords) {
      const hash = await bcrypt.hash(password, 10);
      hashes.push(hash);
    }
  } else {
    const { argon2id } = require('hash-wasm');
    for (const password of passwords) {
      const salt = new Uint8Array(16);
      crypto.randomFillSync(salt);
      const hash = await argon2id({
        password,
        salt,
        parallelism: 1,
        iterations: 3,
        memorySize: 65536,
        hashLength: 32,
        outputType: 'encoded'
      });
      hashes.push(hash);
    }
  }

  return hashes;
}

class RedisClient {
  constructor(host, port, password) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.socket = null;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();
      this.socket.setEncoding('utf8');
      this.socket.setTimeout(60000);

      this.socket.connect(this.port, this.host, async () => {
        if (this.password) {
          try {
            await this.auth(this.password);
          } catch (error) {
            reject(new Error(`Redis AUTH failed: ${error.message}`));
            return;
          }
        }
        resolve();
      });

      this.socket.on('error', reject);
      this.socket.on('timeout', () => reject(new Error('Connection timeout')));
    });
  }

  buildCommand(args) {
    let cmd = `*${args.length}\r\n`;
    for (const arg of args) {
      const strArg = String(arg);
      cmd += `$${Buffer.byteLength(strArg)}\r\n${strArg}\r\n`;
    }
    return cmd;
  }

  sendCommand(args) {
    return new Promise((resolve, reject) => {
      const cmd = this.buildCommand(args);

      let response = '';
      const onData = (data) => {
        response += data;
        try {
          const result = this.parseResponse(response);
          if (result.complete) {
            this.socket.removeListener('data', onData);
            if (result.error) {
              reject(new Error(result.value));
            } else {
              resolve(result.value);
            }
          }
        } catch (e) {
          // Response incomplete, wait for more data
        }
      };

      this.socket.on('data', onData);
      this.socket.write(cmd);
    });
  }

  sendPipeline(commandsList) {
    return new Promise((resolve, reject) => {
      let pipeline = '';
      for (const args of commandsList) {
        pipeline += this.buildCommand(args);
      }

      const expectedResponses = commandsList.length;
      let response = '';
      let parsedCount = 0;
      const results = [];

      const onData = (data) => {
        response += data;

        while (parsedCount < expectedResponses) {
          const result = this.parseResponseAt(response, 0);
          if (!result.complete) break;

          results.push(result.error ? { error: result.value } : { value: result.value });
          response = response.substring(result.consumed);
          parsedCount++;
        }

        if (parsedCount >= expectedResponses) {
          this.socket.removeListener('data', onData);
          resolve(results);
        }
      };

      this.socket.on('data', onData);
      this.socket.write(pipeline);
    });
  }

  parseResponse(data) {
    return this.parseResponseAt(data, 0);
  }

  parseResponseAt(data, offset) {
    if (offset >= data.length) return { complete: false };

    const type = data[offset];
    const endIdx = data.indexOf('\r\n', offset);
    if (endIdx === -1) return { complete: false };

    const consumed = () => endIdx - offset + 2;

    switch (type) {
      case '+':
        return { complete: true, value: data.substring(offset + 1, endIdx), consumed: consumed() };
      case '-':
        return { complete: true, error: true, value: data.substring(offset + 1, endIdx), consumed: consumed() };
      case ':':
        return { complete: true, value: parseInt(data.substring(offset + 1, endIdx), 10), consumed: consumed() };
      case '$':
        const len = parseInt(data.substring(offset + 1, endIdx), 10);
        if (len === -1) return { complete: true, value: null, consumed: consumed() };
        const valueStart = endIdx + 2;
        const valueEnd = valueStart + len;
        if (data.length < valueEnd + 2) return { complete: false };
        return { complete: true, value: data.substring(valueStart, valueEnd), consumed: valueEnd + 2 - offset };
      case '*':
        return { complete: true, value: 'OK', consumed: consumed() };
      default:
        return { complete: true, value: data.substring(offset), consumed: data.length - offset };
    }
  }

  async auth(password) {
    return this.sendCommand(['AUTH', password]);
  }

  async mset(keyValuePairs) {
    const commands = keyValuePairs.map(({ key, value }) => {
      return ['SET', key, JSON.stringify(value)];
    });
    return this.sendPipeline(commands);
  }

  close() {
    if (this.socket) {
      this.socket.end();
    }
  }
}

function hashMatchesAlgorithm(hash, algorithm) {
  if (algorithm === 'bcrypt-hs256') {
    return hash.startsWith('$2a$') || hash.startsWith('$2b$');
  }
  return hash.startsWith('$argon2id$');
}

async function prepareBatch(users, authMode, hasPrecomputedHashes, algorithm) {
  const createdAt = new Date().toISOString();

  if (authMode === 'none') {
    return users.map(user => ({
      key: `user:${user.userName}`,
      value: { password: user.password }
    }));
  } else if (authMode === 'service-integrated-manual') {
    // Use precomputed hashes if available and they match the requested algorithm
    if (hasPrecomputedHashes && users.every(u => u.passwordHash && hashMatchesAlgorithm(u.passwordHash, algorithm))) {
      return users.map(user => ({
        key: `user:${user.userName}`,
        value: {
          userName: user.userName,
          passwordHash: user.passwordHash,
          createdAt
        }
      }));
    }

    // Fallback: compute hashes at runtime
    if (hasPrecomputedHashes) {
      console.log(`  Warning: CSV hashes don't match algorithm '${algorithm}', computing at runtime`);
    } else {
      console.log(`  Warning: Computing hashes at runtime (CSV lacks passwordHash column, using ${algorithm || 'argon2id-eddsa'})`);
    }
    const passwords = users.map(u => u.password);
    const hashes = await hashPasswordsBatch(passwords, algorithm);

    return users.map((user, i) => ({
      key: `user:${user.userName}`,
      value: {
        userName: user.userName,
        passwordHash: hashes[i],
        createdAt
      }
    }));
  } else {
    return users.map(user => ({
      key: `user:${user.userName}`,
      value: { password: user.password }
    }));
  }
}

async function main() {
  const redisEndpoint = process.env.REDIS_ENDPOINT;
  const authMode = process.env.AUTH_MODE || 'none';
  const algorithm = process.env.ALGORITHM || 'argon2id-eddsa';

  if (!redisEndpoint) {
    console.log('REDIS_ENDPOINT not set, skipping preregistration');
    process.exit(0);
  }

  console.log('='.repeat(60));
  console.log('  Pre-registering Users in Redis');
  console.log('='.repeat(60));
  console.log(`Auth mode: ${authMode}`);
  if (authMode === 'service-integrated-manual') {
    console.log(`Algorithm: ${algorithm}`);
  }
  console.log(`Batch size: ${BATCH_SIZE}`);

  // Parse users
  console.log('\nReading users from users.csv...');
  const { users, hasPrecomputedHashes } = parseUsersCSV();
  console.log(`Found ${users.length} users`);

  if (hasPrecomputedHashes && authMode === 'service-integrated-manual') {
    const sampleHash = users.find(u => u.passwordHash)?.passwordHash || '';
    if (hashMatchesAlgorithm(sampleHash, algorithm)) {
      console.log('Using precomputed password hashes from CSV (fast mode)');
    } else {
      console.log(`Warning: CSV hashes don't match algorithm '${algorithm}' - will compute at runtime (slow)`);
    }
  } else if (!hasPrecomputedHashes && authMode === 'service-integrated-manual') {
    console.log('Warning: No passwordHash column found - will compute hashes at runtime (slow)');
    console.log('Tip: Run migrateUsers.js to add precomputed hashes to your users.csv');
  }

  // Parse Redis URL
  const redisConfig = parseRedisUrl(redisEndpoint);
  console.log(`Redis host: ${redisConfig.host}:${redisConfig.port}`);

  // Connect to Redis
  console.log('\nConnecting to Redis...');
  const redis = new RedisClient(redisConfig.host, redisConfig.port, redisConfig.password);
  await redis.connect();
  console.log('Connected to Redis');

  // Register users in batches
  console.log(`\nRegistering users...`);
  const startTime = Date.now();
  let registered = 0;
  let failed = 0;

  const totalBatches = Math.ceil(users.length / BATCH_SIZE);

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const start = batchIdx * BATCH_SIZE;
    const end = Math.min(start + BATCH_SIZE, users.length);
    const batch = users.slice(start, end);

    try {
      const keyValuePairs = await prepareBatch(batch, authMode, hasPrecomputedHashes, algorithm);
      const results = await redis.mset(keyValuePairs);

      for (const result of results) {
        if (result.error) {
          failed++;
        } else {
          registered++;
        }
      }
    } catch (error) {
      failed += batch.length;
      console.error(`\nBatch ${batchIdx + 1} failed: ${error.message}`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    process.stdout.write(`\rProgress: ${end}/${users.length} (${Math.round(end / users.length * 100)}%) - ${elapsed}s`);
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n');
  redis.close();

  console.log('Results:');
  console.log(`  Registered: ${registered}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Time: ${totalElapsed}s`);
  console.log(`  Rate: ${Math.round(registered / parseFloat(totalElapsed))} users/sec`);
  console.log('='.repeat(60));

  if (failed > 0 && failed === users.length) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});
