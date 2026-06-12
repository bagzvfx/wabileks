/**
 * ╔══════════════════════════════════════════════╗
 * ║        Baileys Custom Socket Helper          ║
 * ║     Socket Helper & Message Serializer       ║
 * ╚══════════════════════════════════════════════╝
 */

import path from 'path';
import { pathToFileURL } from 'url';
import { downloadMediaMessage } from './messages.js';

// ─────────────────────────────────────────────────────────────
//  JID HELPERS
// ─────────────────────────────────────────────────────────────

export function cleanJid(jid) {
    if (!jid) return '';
    return jid.includes(':')
        ? jid.replace(/:\d+/, '')
        : jid;
}

export function getPhoneNumber(jid) {
    return cleanJid(jid).split('@')[0];
}

// ─────────────────────────────────────────────────────────────
//  DYNAMIC DATABASE RESOLUTION
// ─────────────────────────────────────────────────────────────

let db = null;

async function getDb() {
    if (db) return db;
    try {
        const dbPath = path.join(process.cwd(), 'lib/setup/database.js');
        const dbUrl = pathToFileURL(dbPath).toString();
        const dbModule = await import(dbUrl);
        db = dbModule.default || dbModule;
        return db;
    } catch {
        return null;
    }
}

// Trigger background database loading
getDb().catch(() => {});

// ─────────────────────────────────────────────────────────────
//  CONSTANTS & CACHE
// ─────────────────────────────────────────────────────────────

const WRAPPER_TYPES = [
    'senderKeyDistributionMessage',
    'messageContextInfo',
    'deviceSentMessage',
    'protocolMessage',
    'reactionMessage',
];

const _groupCache = new Map();
const GROUP_CACHE_TTL = 5 * 60 * 1000;

/**
 * Ambil metadata grup dengan cache 5 menit.
 */
async function getGroupMeta(sock, jid) {
    const cached = _groupCache.get(jid);
    if (cached && (Date.now() - cached.time) < GROUP_CACHE_TTL) {
        return cached.data;
    }
    try {
        const data = await sock.groupMetadata(jid);
        _groupCache.set(jid, { data, time: Date.now() });
        return data;
    } catch {
        return null;
    }
}

// ─────────────────────────────────────────────────────────────
//  MESSAGE SERIALIZATION: smsg
// ─────────────────────────────────────────────────────────────

/**
 * Ubah pesan mentah dari Baileys menjadi objek `m` yang rapi.
 *
 * @param {object} rawMsg - Pesan mentah dari Baileys messages.upsert
 * @param {object} sock   - Instance WASocket
 * @returns {Promise<object>} Objek `m` yang sudah diolah
 */
export async function smsg(rawMsg, sock) {
    const m = {};

    // ── Informasi dasar ──────────────────────────────────

    m.key       = rawMsg.key;
    m.id        = rawMsg.key?.id ?? '';
    m.chat      = rawMsg.key?.remoteJid ?? '';
    m.fromMe    = rawMsg.key?.fromMe ?? false;
    m.isGroup   = m.chat.endsWith('@g.us');
    m.pushName  = rawMsg.pushName ?? '';
    m.timestamp = rawMsg.messageTimestamp ?? 0;

    // Sender: di grup = participant, di privat = chat itu sendiri
    m.sender = cleanJid(
        m.isGroup
            ? (rawMsg.key?.participant ?? '')
            : m.fromMe
                ? (sock.user?.id ?? '')
                : m.chat
    );

    // Apakah dari broadcast/newsletter (kita abaikan)
    m.isBroadcast =
        m.chat === 'status@broadcast' ||
        m.chat.includes('broadcast') ||
        m.chat.includes('newsletter');

    // ── Bongkar isi pesan ────────────────────────────────
    //    Baileys kadang membungkus pesan dalam lapisan
    //    ephemeral / viewOnce / document. Kita buka satu per satu.

    let content = rawMsg.message ?? {};

    if (content.ephemeralMessage)
        content = content.ephemeralMessage.message ?? content;
    if (content.viewOnceMessage)
        content = content.viewOnceMessage.message ?? content;
    if (content.viewOnceMessageV2)
        content = content.viewOnceMessageV2.message ?? content;
    if (content.documentWithCaptionMessage)
        content = content.documentWithCaptionMessage.message ?? content;

    // ── Tipe pesan ──────────────────────────────────────
    //    Cari key pertama dari isi pesan yang bukan wrapper.

    m.type       = Object.keys(content).find(k => !WRAPPER_TYPES.includes(k)) ?? '';
    m.msg        = content[m.type] ?? null;

    const simpleTypeMap = {
        imageMessage: 'image',
        videoMessage: 'video',
        stickerMessage: 'sticker',
        audioMessage: 'audio',
        documentMessage: 'document'
    };
    const simpleType = simpleTypeMap[m.type] || '';
    m.isMedia = ['image', 'video', 'audio', 'sticker', 'document'].includes(simpleType);

    // ── Ekstrak teks dari pesan ─────────────────────────
    //    Berbagai jenis pesan menyimpan teks di tempat berbeda.

    m.body =
        content.conversation                                           ??
        content.extendedTextMessage?.text                               ??
        content.imageMessage?.caption                                   ??
        content.videoMessage?.caption                                   ??
        content.documentMessage?.caption                                ??
        content.buttonsResponseMessage?.selectedButtonId                ??
        content.listResponseMessage?.singleSelectReply?.selectedRowId   ??
        content.templateButtonReplyMessage?.selectedId                  ??
        '';

    m.text = m.body;

    // ── Pesan yang dikutip (quoted / reply) ─────────────

    const contextInfo = m.msg?.contextInfo ?? null;

    if (contextInfo?.quotedMessage) {
        const qMsg   = contextInfo.quotedMessage;
        const qType  = Object.keys(qMsg).find(k => !WRAPPER_TYPES.includes(k)) ?? '';

        const qSender = cleanJid(contextInfo.participant || m.chat);

        m.quoted = {
            key: {
                remoteJid   : m.chat,
                id          : contextInfo.stanzaId ?? '',
                fromMe      : qSender === cleanJid(sock.user?.id ?? ''),
                participant : m.isGroup ? (contextInfo.participant ?? '') : undefined,
            },
            type    : qType,
            msg     : qMsg[qType] ?? null,
            sender  : qSender,
            body    :
                qMsg.conversation                  ??
                qMsg.extendedTextMessage?.text      ??
                qMsg.imageMessage?.caption          ??
                qMsg.videoMessage?.caption          ??
                '',
            message : qMsg,
        };
    } else {
        m.quoted = null;
    }

    // ── Mention (user yang ditag) ───────────────────────

    m.mentions = contextInfo?.mentionedJid ?? [];
    m.mentionedJid = m.mentions;

    // ── Fitur Tambahan (m.isAdmin, m.isBotAdmin, dll) ────

    m.isBaileys = m.id.startsWith('3EB0') || m.id.startsWith('BAE5') || m.id.startsWith('3EBS') || m.id.length === 16 || m.id.length === 12;
    m.participant = cleanJid(rawMsg.key?.participant || '');
    m.mime = m.msg?.mimetype || '';

    m.lid = cleanJid(rawMsg.key?.participant || '').endsWith('@lid') 
        ? cleanJid(rawMsg.key?.participant || '') 
        : cleanJid(rawMsg.key?.remoteJid || '').endsWith('@lid') 
            ? cleanJid(rawMsg.key?.remoteJid || '') 
            : '';

    let groupMetadata = null;
    let isAdmin = false;
    let isBotAdmin = false;

    if (m.isGroup) {
        groupMetadata = await getGroupMeta(sock, m.chat);
        if (groupMetadata) {
            const participants = groupMetadata.participants ?? [];
            const botJid = cleanJid(sock.user?.id ?? '');
            isAdmin = participants.some(p => cleanJid(p.id) === m.sender && (p.admin === 'admin' || p.admin === 'superadmin'));
            isBotAdmin = participants.some(p => cleanJid(p.id) === botJid && (p.admin === 'admin' || p.admin === 'superadmin'));
        }
    }

    m.groupMetadata = groupMetadata;
    m.isAdmin = isAdmin;
    m.isBotAdmin = isBotAdmin;

    // ── Helper: balas pesan ─────────────────────────────
    //    Bisa kirim teks: await m.reply('halo!')
    //    Bisa kirim media: await m.reply({ image: buffer, caption: '...' })

    m.reply = async (isi) => {
        const payload = typeof isi === 'string' ? { text: isi } : isi;
        return sock.sendMessage(m.chat, payload, { quoted: rawMsg });
    };

    // ── Helper: react dengan emoji ──────────────────────
    //    Contoh: await m.react('✅')

    m.react = async (emoji) => {
        return sock.sendMessage(m.chat, {
            react: { text: emoji, key: rawMsg.key },
        });
    };

    // ── Helper: hapus pesan ─────────────────────────────

    m.delete = async () => {
        return sock.sendMessage(m.chat, { delete: rawMsg.key });
    };

    // ── Helper: edit pesan ──────────────────────────────

    m.edit = async (text) => {
        return sock.sendMessage(m.chat, { text, edit: rawMsg.key });
    };

    // ── Helper: download media ──────────────────────────

    m.download = async () => {
        return downloadMediaMessage(rawMsg, 'buffer', {});
    };

    // ── Helper: copy & forward pesan ────────────────────

    m.copyNForward = async (jid = m.chat, forceForward = false, options = {}) => {
        return sock.sendMessage(jid, { forward: rawMsg, force: forceForward }, options);
    };

    // ── Helper: copy/clone pesan ────────────────────────

    m.copy = async () => {
        return await smsg(JSON.parse(JSON.stringify(rawMsg)), sock);
    };

    return m;
}

// ─────────────────────────────────────────────────────────────
//  SOCKET DECORATOR: socket
// ─────────────────────────────────────────────────────────────

/**
 * Menyuntikkan metode bantuan kustom langsung ke dalam objek WASocket.
 *
 * @param {object} sock - Instansi WASocket
 * @returns {object} sock yang sudah didekorasi
 */
export function socket(sock) {
    if (!sock) return sock;

    // ── Properti Bawaan / Database ───────────────────────
    Object.defineProperty(sock, 'chats', {
        get() {
            return db?.data?.chats || {};
        },
        configurable: true,
        enumerable: true
    });

    // ── Logger ───────────────────────────────────────────
    sock.logger = sock.logger || console;

    // ── DECODE JID ───────────────────────────────────────
    /**
     * Membersihkan dan mendekode JID multi-device ke JID dasar.
     * @param {string} jid
     * @returns {string}
     */
    sock.decodeJid = (jid) => {
        if (!jid) return jid;
        if (/:\d+@/gi.test(jid)) {
            const decode = jid.split('@');
            const user = decode[0].split(':')[0];
            const server = decode[1];
            return `${user}@${server}`;
        }
        return cleanJid(jid);
    };

    // ── GET NAME ─────────────────────────────────────────
    sock.getName = (jid) => {
        if (!jid) return '';
        const clean = cleanJid(jid);
        if (clean.endsWith('@g.us')) {
            return clean;
        }
        if (db && typeof db.getUser === 'function') {
            const user = db.getUser(clean);
            if (user?.name) return user.name;
        }
        return getPhoneNumber(clean);
    };

    // ── GET FILE / DOWNLOAD BUFFER ───────────────────────
    /**
     * Membaca/mengunduh file dari URL, Buffer, Path, atau Base64.
     * @param {string|Buffer} PATH
     * @param {boolean} [save=false]
     * @returns {Promise<{res: Response, filename: string, size: number, mime: string, ext: string, data: Buffer}>}
     */
    sock.getFile = async (PATH, save = false) => {
        let res;
        let data;
        if (Buffer.isBuffer(PATH)) {
            data = PATH;
        } else if (/^data:.*?\/.*?;base64,/i.test(PATH)) {
            data = Buffer.from(PATH.split(',')[1], 'base64');
        } else if (/^https?:\/\//.test(PATH)) {
            res = await fetch(PATH);
            const arrayBuffer = await res.arrayBuffer();
            data = Buffer.from(arrayBuffer);
        } else {
            try {
                const fs = await import('fs/promises');
                data = await fs.readFile(PATH);
            } catch {
                data = Buffer.alloc(0);
            }
        }

        let type = { mime: 'application/octet-stream', ext: 'bin' };
        try {
            const { fileTypeFromBuffer } = await import('file-type');
            const detected = await fileTypeFromBuffer(data);
            if (detected) type = detected;
        } catch {}

        let filename = '';
        if (save) {
            try {
                const fs = await import('fs/promises');
                const path = await import('path');
                filename = path.join(process.cwd(), 'tmp', `${Date.now()}.${type.ext}`);
                await fs.mkdir(path.dirname(filename), { recursive: true });
                await fs.writeFile(filename, data);
            } catch {}
        }

        return {
            res,
            filename,
            size: data.length,
            mime: type.mime,
            ext: type.ext,
            data
        };
    };

    // ── WAIT EVENT ───────────────────────────────────────
    /**
     * Menunggu suatu event Baileys terpicu sekali berdasarkan filter.
     * @param {string} eventName
     * @param {Function} [isTrigger=()=>true]
     * @param {number} [timeout=60000]
     * @returns {Promise<any>}
     */
    sock.waitEvent = (eventName, isTrigger = () => true, timeout = 60000) => {
        return new Promise((resolve, reject) => {
            const handler = (data) => {
                if (isTrigger(data)) {
                    sock.ev.off(eventName, handler);
                    clearTimeout(timer);
                    resolve(data);
                }
            };
            const timer = setTimeout(() => {
                sock.ev.off(eventName, handler);
                reject(new Error(`waitEvent for ${eventName} timed out`));
            }, timeout);
            sock.ev.on(eventName, handler);
        });
    };

    // ── SEND FILE ────────────────────────────────────────
    /**
     * Mengirim file media atau dokumen dengan deteksi format otomatis.
     */
    sock.sendFile = async (jid, content, filename = '', caption = '', quoted = {}, options = {}) => {
        const file = await sock.getFile(content);
        let type = file.mime.split('/')[0];
        let payload = {};
        if (type === 'image') {
            payload = { image: file.data, caption, ...options };
        } else if (type === 'video') {
            payload = { video: file.data, caption, ...options };
        } else if (type === 'audio') {
            payload = { audio: file.data, mimetype: file.mime, ...options };
        } else if (file.mime === 'image/gif') {
            payload = { video: file.data, gifPlayback: true, caption, ...options };
        } else {
            payload = { document: file.data, mimetype: file.mime, fileName: filename || `file.${file.ext}`, caption, ...options };
        }
        return sock.sendMessage(jid, payload, { quoted });
    };

    // ── SEND TEXT ────────────────────────────────────────
    sock.sendText = async (jid, text, quoted = {}, options = {}) => {
        return sock.sendMessage(jid, { text, ...options }, { quoted });
    };

    // ── SEND TEXT WITH MENTIONS ──────────────────────────
    sock.sendTextWithMentions = async (jid, text, quoted = {}, options = {}) => {
        const mentions = [...text.matchAll(/@(\d+)/g)].map(v => v[1] + '@s.whatsapp.net');
        return sock.sendMessage(jid, { text, mentions, ...options }, { quoted });
    };

    // ── PARSE MENTION ────────────────────────────────────
    sock.parseMention = (text) => {
        return [...text.matchAll(/@(\d+)/g)].map(v => v[1] + '@s.whatsapp.net');
    };

    // ── SEND IMAGE ───────────────────────────────────────
    sock.sendImage = async (jid, content, caption = '', quoted = {}, options = {}) => {
        const payload = typeof content === 'string'
            ? { image: { url: content }, caption, ...options }
            : { image: content, caption, ...options };
        return sock.sendMessage(jid, payload, { quoted });
    };

    // ── SEND VIDEO ───────────────────────────────────────
    sock.sendVideo = async (jid, content, caption = '', quoted = {}, options = {}) => {
        const payload = typeof content === 'string'
            ? { video: { url: content }, caption, ...options }
            : { video: content, caption, ...options };
        return sock.sendMessage(jid, payload, { quoted });
    };

    // ── SEND AUDIO ───────────────────────────────────────
    sock.sendAudio = async (jid, content, ptt = false, quoted = {}, options = {}) => {
        const payload = typeof content === 'string'
            ? { audio: { url: content }, ptt, ...options }
            : { audio: content, ptt, ...options };
        return sock.sendMessage(jid, payload, { quoted });
    };

    // ── SEND STICKER ─────────────────────────────────────
    sock.sendSticker = async (jid, content, quoted = {}, options = {}) => {
        const payload = typeof content === 'string'
            ? { sticker: { url: content }, ...options }
            : { sticker: content, ...options };
        return sock.sendMessage(jid, payload, { quoted });
    };

    // ── SEND CONTACT ─────────────────────────────────────
    sock.sendContact = async (jid, number, name, quoted = {}, options = {}) => {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        const vcard = 'BEGIN:VCARD\n'
            + 'VERSION:3.0\n'
            + 'FN:' + name + '\n'
            + 'ORG:Remielle Bot;\n'
            + 'TEL;type=CELL;type=VOICE;waid=' + cleanNumber + ':+' + cleanNumber + '\n'
            + 'END:VCARD';
        return sock.sendMessage(jid, {
            contacts: {
                displayName: name,
                contacts: [{ vcard }]
            }
        }, { quoted, ...options });
    };

    // ── SEND CONTACT ARRAY ───────────────────────────────
    sock.sendContactArray = async (jid, contactsArray, quoted = {}, options = {}) => {
        const contacts = contactsArray.map(c => {
            const cleanNumber = c.number.replace(/[^0-9]/g, '');
            return {
                vcard: 'BEGIN:VCARD\n'
                    + 'VERSION:3.0\n'
                    + 'FN:' + c.name + '\n'
                    + 'TEL;type=CELL;type=VOICE;waid=' + cleanNumber + ':+' + cleanNumber + '\n'
                    + 'END:VCARD'
            };
        });
        return sock.sendMessage(jid, {
            contacts: {
                displayName: `${contactsArray.length} Kontak`,
                contacts
            }
        }, { quoted, ...options });
    };

    // ── DOWNLOAD MEDIA MESSAGE ───────────────────────────
    sock.downloadMediaMessage = async (message) => {
        return downloadMediaMessage(message, 'buffer', {});
    };
    sock.downloadM = sock.downloadMediaMessage;

    // ── RESIZE IMAGE BUFFER ──────────────────────────────
    sock.resize = async (buffer, width, height) => {
        try {
            const Jimp = (await import('jimp')).default;
            const o = await Jimp.read(buffer);
            return await o.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
        } catch {
            return buffer;
        }
    };

    // ── REPLY HELPER ─────────────────────────────────────
    sock.reply = async (jid, text, quoted, options = {}) => {
        return sock.sendMessage(jid, { text, ...options }, { quoted });
    };

    // ── DATE / TIME HELPERS ──────────────────────────────
    sock.msToDate = (ms) => {
        return new Date(ms).toLocaleString('id-ID');
    };
    sock.delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // ── COPY AND MODIFY (cMod) ───────────────────────────
    sock.cMod = (jid, message, text = '', sender = sock.user?.id, options = {}) => {
        let copy = { ...message };
        copy.key = {
            remoteJid: jid,
            fromMe: sender === sock.decodeJid(sock.user?.id),
            id: message.key.id,
            participant: sender
        };
        if (text) {
            if (copy.message?.conversation) copy.message.conversation = text;
            else if (copy.message?.extendedTextMessage?.text) copy.message.extendedTextMessage.text = text;
        }
        return copy;
    };

    // ── COPY AND FORWARD ─────────────────────────────────
    sock.copyNForward = async (jid, message, forceForward = false, options = {}) => {
        return sock.sendMessage(jid, { forward: message, force: forceForward }, options);
    };

    // ── FAKE REPLY ───────────────────────────────────────
    sock.fakeReply = async (jid, text, fakeJid, fakeText, options = {}) => {
        return sock.sendMessage(jid, { text }, {
            quoted: {
                key: {
                    fromMe: false,
                    participant: fakeJid,
                    remoteJid: 'status@broadcast'
                },
                message: {
                    conversation: fakeText
                }
            },
            ...options
        });
    };

    // ── LOAD MESSAGE (STORE COMPAT) ──────────────────────
    sock.loadMessage = async (id) => {
        if (sock.store && typeof sock.store.loadMessage === 'function') {
            return await sock.store.loadMessage(id);
        }
        return null;
    };

    // ── SEND GROUP V4 INVITE ─────────────────────────────
    sock.sendGroupV4Invite = async (jid, participant, inviteCode, inviteExpiration, groupName, caption = '', options = {}) => {
        return sock.sendMessage(jid, {
            groupInviteV4: {
                inviteCode,
                inviteExpiration: parseInt(inviteExpiration),
                groupJid: participant,
                groupName,
                caption
            },
            ...options
        });
    };

    // ── RELAY WA MESSAGE ─────────────────────────────────
    sock.relayWAMessage = async (message) => {
        return sock.relayMessage(message.key.remoteJid, message.message, { messageId: message.key.id });
    };

    // ── INSERT ALL GROUPS TO DATABASE ────────────────────
    sock.insertAllGroup = async () => {
        try {
            await getDb();
            const groups = await sock.groupFetchAllParticipating();
            if (db && typeof db.getChat === 'function') {
                for (const [jid, group] of Object.entries(groups)) {
                    db.getChat(jid);
                }
                if (typeof db.write === 'function') {
                    await db.write();
                }
            }
            return groups;
        } catch {
            return {};
        }
    };

    // ── PUSH MESSAGE & STUB TYPE ─────────────────────────
    sock.pushMessage = async (message) => { return null; };
    sock.processMessageStubType = async (stubType, stubParameters) => { return null; };

    // ── SET STATUS / BIO ─────────────────────────────────
    sock.setBio = async (status) => {
        return sock.query({
            tag: 'iq',
            attrs: {
                to: '@s.whatsapp.net',
                type: 'set',
                xmlns: 'status',
            },
            content: [{
                tag: 'status',
                attrs: {},
                content: Buffer.from(status, 'utf-8')
            }]
        });
    };
    sock.setStatus = sock.setBio;

    // ── SERIALIZE MESSAGE (smsg) ─────────────────────────
    sock.serializeM = async (message) => {
        return await smsg(message, sock);
    };

    // ── UPDATE PROFILE PICTURE ───────────────────────────
    sock.updateProfilePicture = async (jid, content) => {
        const file = await sock.getFile(content);
        return sock.query({
            tag: 'iq',
            attrs: {
                to: cleanJid(jid),
                type: 'set',
                xmlns: 'w:profile:picture'
            },
            content: [{
                tag: 'picture',
                attrs: { type: 'image' },
                content: file.data
            }]
        });
    };

    // ── READ CHAT / MESSAGES ─────────────────────────────
    sock.chatRead = async (jid, participant, id) => {
        return sock.readMessages([{ remoteJid: jid, id, participant }]);
    };

    // ── SEND ALBUM ───────────────────────────────────────
    /**
     * Mengirim beberapa media (gambar/video) berturut-turut sebagai album.
     */
    sock.sendAlbum = async (jid, mediaArray, caption = '', quoted = {}, options = {}) => {
        const sent = [];
        for (let i = 0; i < mediaArray.length; i++) {
            const file = await sock.getFile(mediaArray[i]);
            const cap = i === mediaArray.length - 1 ? caption : '';
            const type = file.mime.split('/')[0];
            const payload = type === 'image' ? { image: file.data, caption: cap } : { video: file.data, caption: cap };
            const msg = await sock.sendMessage(jid, payload, { quoted, ...options });
            sent.push(msg);
            await new Promise(r => setTimeout(r, 1000));
        }
        return sent;
    };

    // ── SEND PAYMENT REQUEST ─────────────────────────────
    sock.sendPayment = async (jid, amount, currency, text, quoted = {}, options = {}) => {
        return sock.sendMessage(jid, {
            requestPaymentMessage: {
                currencyCodeIso4217: currency || 'IDR',
                amount1000: parseInt(amount) * 1000,
                requestFrom: jid,
                noteMessage: {
                    extendedTextMessage: {
                        text: text || ''
                    }
                },
                expiryTimestamp: 0
            }
        }, { quoted, ...options });
    };

    // ── SEND BUTTON (NATIVE FLOW) ────────────────────────
    sock.sendButton = async (jid, text, footer, buttons = [], quoted = {}, options = {}) => {
        const formattedButtons = buttons.map(btn => {
            const type = btn.type || 'quick_reply';
            if (type === 'url') {
                return {
                    name: 'cta_url',
                    buttonParamsJson: JSON.stringify({
                        display_text: btn.text,
                        url: btn.url,
                        merchant_url: btn.url
                    })
                };
            } else if (type === 'call') {
                return {
                    name: 'cta_call',
                    buttonParamsJson: JSON.stringify({
                        display_text: btn.text,
                        phone_number: btn.phone || btn.number
                    })
                };
            } else {
                return {
                    name: 'quick_reply',
                    buttonParamsJson: JSON.stringify({
                        display_text: btn.text,
                        id: btn.id || btn.value || ''
                    })
                };
            }
        });

        const message = {
            viewOnceMessage: {
                message: {
                    interactiveMessage: {
                        body: { text: text },
                        footer: { text: footer || '' },
                        header: {
                            title: '',
                            hasMediaAttachment: false
                        },
                        nativeFlowMessage: {
                            buttons: formattedButtons,
                            messageVersion: 1
                        }
                    }
                }
            }
        };

        return sock.sendMessage(jid, message, { quoted, ...options });
    };

    // ── SEND LIST (SINGLE SELECT) ────────────────────────
    sock.sendList = async (jid, title, text, footer, buttonText, sections = [], quoted = {}, options = {}) => {
        const message = {
            viewOnceMessage: {
                message: {
                    interactiveMessage: {
                        body: { text: text },
                        footer: { text: footer || '' },
                        header: {
                            title: title || '',
                            hasMediaAttachment: false
                        },
                        nativeFlowMessage: {
                            buttons: [{
                                name: "single_select",
                                buttonParamsJson: JSON.stringify({
                                    title: buttonText || "Pilih opsi",
                                    sections: sections.map(sec => ({
                                        title: sec.title || '',
                                        highlight_label: sec.highlight_label || '',
                                        rows: sec.rows.map(row => ({
                                            title: row.title || '',
                                            id: row.id || row.value || '',
                                            description: row.description || ''
                                        }))
                                    }))
                                })
                            }],
                            messageVersion: 1
                        }
                    }
                }
            }
        };

        return sock.sendMessage(jid, message, { quoted, ...options });
    };

    // ── SEND TEMPLATE BUTTON (CTA MAPPING) ───────────────
    sock.sendTemplateButton = async (jid, text, footer, buttons = [], quoted = {}, options = {}) => {
        const formatted = buttons.map(btn => {
            if (btn.url) {
                return { type: 'url', text: btn.text, url: btn.url };
            } else if (btn.call || btn.phone) {
                return { type: 'call', text: btn.text, phone: btn.call || btn.phone };
            } else {
                return { type: 'quick_reply', text: btn.text, id: btn.quickReply || btn.id || '' };
            }
        });
        return sock.sendButton(jid, text, footer, formatted, quoted, options);
    };

    // ── SEND RELAY MESSAGE ───────────────────────────────
    sock.sendRelayMessage = async (jid, content, options = {}) => {
        return sock.relayMessage(jid, content, options);
    };

    return sock;
}

// ─────────────────────────────────────────────────────────────
//  CACHE CLEANUP EXPORTS
// ─────────────────────────────────────────────────────────────

/**
 * Hapus cache metadata grup untuk satu grup.
 * @param {string} jid - JID grup
 */
export function clearGroupCache(jid) {
    _groupCache.delete(jid);
}

/**
 * Hapus semua cache metadata grup.
 */
export function clearAllGroupCache() {
    _groupCache.clear();
}
