import { Mutex } from 'async-mutex';
import { mkdir, readFile, stat, unlink, writeFile } from 'fs/promises';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { proto } from '../../WAProto/index.js';
import { initAuthCreds } from './auth-utils.js';
import { BufferJSON } from './generics.js';
// We need to lock files due to the fact that we are using async functions to read and write files
// https://github.com/WhiskeySockets/Baileys/issues/794
// https://github.com/nodejs/node/issues/26338
// Use a Map to store mutexes for each file path
const fileLocks = new Map();
// Get or create a mutex for a specific file path
const getFileLock = (path) => {
    let mutex = fileLocks.get(path);
    if (!mutex) {
        mutex = new Mutex();
        fileLocks.set(path, mutex);
    }
    return mutex;
};
/**
 * stores the full authentication state in a single folder.
 * Far more efficient than singlefileauthstate
 *
 * Again, I wouldn't endorse this for any production level use other than perhaps a bot.
 * Would recommend writing an auth state for use with a proper SQL or No-SQL DB
 * */
export const useMultiFileAuthState = async (folder) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const writeData = async (data, file) => {
        const filePath = join(folder, fixFileName(file));
        const mutex = getFileLock(filePath);
        return mutex.acquire().then(async (release) => {
            try {
                await writeFile(filePath, JSON.stringify(data, BufferJSON.replacer));
            }
            finally {
                release();
            }
        });
    };
    const readData = async (file) => {
        try {
            const filePath = join(folder, fixFileName(file));
            const mutex = getFileLock(filePath);
            return await mutex.acquire().then(async (release) => {
                try {
                    const data = await readFile(filePath, { encoding: 'utf-8' });
                    return JSON.parse(data, BufferJSON.reviver);
                }
                finally {
                    release();
                }
            });
        }
        catch (error) {
            return null;
        }
    };
    const removeData = async (file) => {
        try {
            const filePath = join(folder, fixFileName(file));
            const mutex = getFileLock(filePath);
            return mutex.acquire().then(async (release) => {
                try {
                    await unlink(filePath);
                }
                catch {
                }
                finally {
                    release();
                }
            });
        }
        catch { }
    };
    const folderInfo = await stat(folder).catch(() => { });
    if (folderInfo) {
        if (!folderInfo.isDirectory()) {
            throw new Error(`found something that is not a directory at ${folder}, either delete it or specify a different location`);
        }
    }
    else {
        await mkdir(folder, { recursive: true });
    }

    const pidFile = join(folder, 'bot.pid');
    if (existsSync(pidFile)) {
        try {
            const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
            if (pid && pid !== process.pid) {
                try {
                    process.kill(pid, 0);
                    console.log(`\n⚠️ Menemukan instance bot lama berjalan dengan PID ${pid}. Menghentikan secara otomatis...`);
                    process.kill(pid, 'SIGTERM');
                    
                    let killed = false;
                    for (let i = 0; i < 10; i++) {
                        try {
                            process.kill(pid, 0);
                            await new Promise(resolve => setTimeout(resolve, 200));
                        } catch {
                            killed = true;
                            break;
                        }
                    }
                    if (!killed) {
                        try {
                            process.kill(pid, 'SIGKILL');
                        } catch {}
                    }
                    console.log(`✅ Instance bot lama (PID ${pid}) berhasil dihentikan. Memulai instance baru...\n`);
                } catch (e) {
                    // PID lama sudah mati, lanjut
                }
            }
        } catch (e) {
            // Gagal membaca file PID, lanjut
        }
    }
    writeFileSync(pidFile, String(process.pid), 'utf-8');

    // Hapus pidFile saat exit
    process.on('exit', () => {
        try {
            if (existsSync(pidFile)) {
                const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
                if (pid === process.pid) {
                    unlinkSync(pidFile);
                }
            }
        } catch (err) {}
    });

    const fixFileName = (file) => file?.replace(/\//g, '__')?.replace(/:/g, '-');
    const creds = (await readData('creds.json')) || initAuthCreds();
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}.json`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const file = `${category}-${id}.json`;
                            tasks.push(value ? writeData(value, file) : removeData(file));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            return writeData(creds, 'creds.json');
        }
    };
};
//# sourceMappingURL=use-multi-file-auth-state.js.map