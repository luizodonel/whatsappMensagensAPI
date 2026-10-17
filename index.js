const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Setup multer for image upload
const upload = multer({ dest: 'uploads/' });

function getExecutablePath() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    try {
        const whichOut = execSync('which chromium || which chromium-browser || which google-chrome || which google-chrome-stable', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore']
        }).trim().split(/\r?\n/)[0];
        if (whichOut && fs.existsSync(whichOut)) {
            return whichOut;
        }
    } catch (e) {}

    const candidatePaths = [
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/root/.nix-profile/bin/chromium',
        '/nix/var/nix/profiles/default/bin/chromium'
    ];
    for (const p of candidatePaths) {
        if (fs.existsSync(p)) return p;
    }
    return undefined;
}

const detectedExecPath = getExecutablePath();

const logs = [];
function addLog(msg) {
    const entry = `[${new Date().toISOString()}] ${msg}`;
    console.log(entry);
    logs.push(entry);
    if (logs.length > 100) logs.shift();
}

let client = null;
let qrCodeData = null;
let isConnected = false;
let isAuthenticated = false;
let loadingPercent = null;
let campaignProgress = {
    total: 0,
    sent: 0,
    currentNumber: null,
    inProgress: false
};

function cleanSessionLocks() {
    try {
        const authDir = path.join(__dirname, '.wwebjs_auth');
        if (!fs.existsSync(authDir)) return;

        function removeLocksInDir(dir) {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    removeLocksInDir(fullPath);
                } else if (entry.name.startsWith('Singleton')) {
                    try {
                        fs.unlinkSync(fullPath);
                        addLog(`Arquivo de lock do Chromium removido: ${entry.name}`);
                    } catch (e) {}
                }
            }
        }
        removeLocksInDir(authDir);
    } catch (e) {
        console.warn('Erro ao limpar locks do Chromium:', e.message);
    }
}

function initWhatsAppClient() {
    cleanSessionLocks();

    client = new Client({
        authStrategy: new LocalAuth({
            dataPath: path.join(__dirname, '.wwebjs_auth')
        }),
        takeoverOnConflict: true,
        takeoverTimeoutMs: 0,
        authTimeoutMs: 120000, // 2 minutos para evitar erro de auth timeout em servidores lentos
        qrMaxRetries: 10,
        puppeteer: {
            headless: true,
            executablePath: detectedExecPath,
            protocolTimeout: 300000, // 5 minutos de timeout no protocolo puppeteer
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process'
            ]
        }
    });

    client.on('loading_screen', (percent, message) => {
        addLog(`Loading screen: ${percent}% - ${message}`);
        loadingPercent = percent;
        qrCodeData = null; // Oculta o QR code para dar feedback imediato de que o escaneamento ocorreu
    });

    client.on('qr', (qr) => {
        addLog('QR Code gerado com sucesso!');
        qrcode.generate(qr, { small: true });
        qrCodeData = qr;
        loadingPercent = null;
        isAuthenticated = false;
        isConnected = false;
    });

    client.on('authenticated', () => {
        addLog('WhatsApp autenticado com sucesso!');
        isAuthenticated = true;
        qrCodeData = null; // Limpa o QR code imediatamente
    });

    client.on('auth_failure', async (msg) => {
        addLog(`Falha de autenticação: ${msg}`);
        isAuthenticated = false;
        isConnected = false;
        loadingPercent = null;
        qrCodeData = null;
        await resetAndRestartClient('Falha de autenticação detectada');
    });

    client.on('ready', () => {
        addLog('WhatsApp está pronto (ready)!');
        isConnected = true;
        isAuthenticated = true;
        loadingPercent = null;
        qrCodeData = null;
    });

    client.on('disconnected', async (reason) => {
        addLog(`WhatsApp desconectado: ${reason}`);
        isConnected = false;
        isAuthenticated = false;
        loadingPercent = null;
        qrCodeData = null;
        await resetAndRestartClient(`Desconectado (${reason})`);
    });
}

let isRestarting = false;
async function resetAndRestartClient(reason = 'Reinicialização') {
    if (isRestarting) {
        addLog('Já existe uma reinicialização em andamento...');
        return;
    }
    isRestarting = true;
    addLog(`Iniciando reinicialização do cliente WhatsApp: ${reason}`);

    qrCodeData = null;
    isConnected = false;
    isAuthenticated = false;
    loadingPercent = null;

    try {
        if (client) {
            await client.destroy();
        }
    } catch (e) {
        console.warn('Erro ao destruir client:', e.message);
    }

    try {
        const authDir = path.join(__dirname, '.wwebjs_auth');
        if (fs.existsSync(authDir)) {
            addLog('Limpando pasta .wwebjs_auth para restaurar estado limpo...');
            fs.rmSync(authDir, { recursive: true, force: true });
        }
    } catch (e) {
        console.warn('Erro ao remover .wwebjs_auth:', e.message);
    }

    cleanSessionLocks();
    await delay(2000);

    initWhatsAppClient();

    try {
        addLog('Chamando client.initialize() após reset...');
        await client.initialize();
        addLog('client.initialize() concluído com sucesso após reset.');
    } catch (err) {
        addLog(`ERRO ao inicializar após reset: ${err.message || err}`);
    } finally {
        isRestarting = false;
    }
}

// Inicialização inicial
initWhatsAppClient();

addLog(`Executável detectado: ${detectedExecPath || 'padrão (Puppeteer Cache)'}`);
addLog('Chamando client.initialize()...');
client.initialize().then(() => {
    addLog('client.initialize() concluído com sucesso.');
}).catch((err) => {
    addLog(`ERRO em client.initialize(): ${err.message || err}`);
    console.error('Erro ao inicializar WhatsApp Client:', err);
    setTimeout(() => {
        resetAndRestartClient(`Recuperação de falha inicial: ${err.message || err}`);
    }, 3000);
});

// Routes
app.get('/api/status', (req, res) => {
    res.json({
        connected: isConnected,
        authenticated: isAuthenticated,
        loadingPercent: loadingPercent,
        qrCode: qrCodeData,
        campaign: campaignProgress
    });
});

app.get('/api/debug', (req, res) => {
    const candidatePaths = [
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/root/.nix-profile/bin/chromium',
        '/nix/var/nix/profiles/default/bin/chromium'
    ];
    const pathChecks = {};
    for (const p of candidatePaths) {
        pathChecks[p] = fs.existsSync(p);
    }
    res.json({
        logs,
        isConnected,
        hasQr: !!qrCodeData,
        executablePath: detectedExecPath || 'default',
        pathChecks,
        envPuppeteerPath: process.env.PUPPETEER_EXECUTABLE_PATH || null
    });
});

app.get('/api/retry', async (req, res) => {
    try {
        addLog('Tentando reinicializar client via /api/retry...');
        resetAndRestartClient('Disparado via /api/retry');
        res.json({ success: true, message: 'Inicialização disparada com sucesso' });
    } catch (e) {
        addLog(`Falha no retry: ${e.message}`);
        res.status(500).json({ success: false, error: e.message });
    }
});

const delay = (ms) => new Promise(res => setTimeout(res, ms));

function formatPhoneNumber(num) {
    if (!num) return null;
    let clean = String(num).replace(/\D/g, '');
    if (!clean) return null;
    // Se tiver 10 ou 11 dígitos (DDD + número brasileiro, ex: 61982261155), adiciona o DDI 55
    if (clean.length === 10 || clean.length === 11) {
        clean = '55' + clean;
    }
    return clean;
}

async function resolveWhatsAppId(client, number) {
    // 1. Tenta getNumberId direto
    try {
        const contactId = await client.getNumberId(number);
        if (contactId && contactId._serialized) {
            return contactId._serialized;
        }
    } catch (e) {
        console.warn(`getNumberId direto falhou para ${number}: ${e.message}`);
    }

    // 2. Se for número brasileiro com 55 e 13 dígitos (55 + DDD + 9 + 8 dígitos), tenta sem o 9
    if (number.length === 13 && number.startsWith('55')) {
        const without9 = number.slice(0, 4) + number.slice(5);
        try {
            const contactId = await client.getNumberId(without9);
            if (contactId && contactId._serialized) {
                return contactId._serialized;
            }
        } catch (e) {}
    } else if (number.length === 12 && number.startsWith('55')) {
        // Se tem 12 dígitos, tenta com 9
        const with9 = number.slice(0, 4) + '9' + number.slice(4);
        try {
            const contactId = await client.getNumberId(with9);
            if (contactId && contactId._serialized) {
                return contactId._serialized;
            }
        } catch (e) {}
    }

    // 3. Fallback direto para @c.us
    return `${number}@c.us`;
}

app.post('/api/send', upload.array('images'), async (req, res) => {
    if (!isConnected) {
        return res.status(400).json({ error: 'WhatsApp não está conectado' });
    }

    if (campaignProgress.inProgress) {
        return res.status(400).json({ error: 'Já existe um envio em andamento' });
    }

    const { description, message, numbers } = req.body;
    const files = req.files;
    const textToSend = (message !== undefined ? message : description) || '';

    // Obter lista de números
    let rawNumbers = [];
    if (typeof numbers === 'string') {
        rawNumbers = numbers.split(/[,;\n\r]+/).map(n => n.trim()).filter(Boolean);
    } else if (Array.isArray(numbers)) {
        rawNumbers = numbers.map(n => String(n).trim()).filter(Boolean);
    }

    // Validação estrita: apenas dispara para números explicitamente fornecidos
    if (rawNumbers.length === 0) {
        return res.status(400).json({ error: 'Nenhum número foi informado. Insira os números separados por vírgula no campo de destinatários.' });
    }

    const cleanedNumbers = [];
    for (const num of rawNumbers) {
        const formatted = formatPhoneNumber(num);
        if (formatted && !cleanedNumbers.includes(formatted)) {
            cleanedNumbers.push(formatted);
        }
    }

    if (cleanedNumbers.length === 0) {
        return res.status(400).json({ error: 'Nenhum número válido foi encontrado na lista informada.' });
    }

    if (!textToSend.trim() && (!files || files.length === 0)) {
        return res.status(400).json({ error: 'Por favor, informe uma mensagem ou anexe ao menos uma foto.' });
    }

    addLog(`Iniciando envio para ${cleanedNumbers.length} contato(s)...`);

    campaignProgress = {
        total: cleanedNumbers.length,
        sent: 0,
        currentNumber: null,
        inProgress: true
    };

    res.json({ message: 'Envio iniciado com sucesso', total: cleanedNumbers.length });

    // Processamento em segundo plano
    (async () => {
        try {
            for (let i = 0; i < cleanedNumbers.length; i++) {
                const number = cleanedNumbers[i];
                campaignProgress.currentNumber = number;

                try {
                    const whatsappId = await resolveWhatsAppId(client, number);

                    // 1. Enviar fotos (com a mensagem como legenda na última foto, se houver texto)
                    if (files && files.length > 0) {
                        for (let j = 0; j < files.length; j++) {
                            const file = files[j];
                            const ext = path.extname(file.originalname);
                            const newPath = file.path + (ext ? ext : '.jpg');
                            if (!fs.existsSync(newPath)) {
                                fs.copyFileSync(file.path, newPath);
                            }

                            const media = MessageMedia.fromFilePath(newPath);

                            if (j === files.length - 1 && textToSend.trim()) {
                                await client.sendMessage(whatsappId, media, { caption: textToSend.trim() });
                            } else {
                                await client.sendMessage(whatsappId, media);
                            }
                            await delay(1500);
                        }
                    } else if (textToSend.trim()) {
                        // Sem imagens, apenas mensagem de texto
                        await client.sendMessage(whatsappId, textToSend.trim());
                        await delay(1000);
                    }

                    campaignProgress.sent++;
                    addLog(`[${i + 1}/${cleanedNumbers.length}] Enviado com sucesso para ${number}`);
                } catch (err) {
                    console.error(`Erro ao enviar para ${number}:`, err.message);
                    addLog(`[ERRO] Falha no envio para ${number}: ${err.message}`);
                    fs.appendFileSync(path.join(__dirname, 'erros_envio.txt'), `${number} - Erro: ${err.message}\n`);
                }

                // Intervalo entre envios se houver mais de um número
                if (i < cleanedNumbers.length - 1) {
                    const waitTime = Math.floor(Math.random() * 3000) + 4000; // 4 a 7 segundos
                    addLog(`Aguardando ${(waitTime / 1000).toFixed(1)}s antes do próximo envio...`);
                    await delay(waitTime);
                }
            }

            addLog(`Envio finalizado! Total enviados: ${campaignProgress.sent} de ${cleanedNumbers.length}`);
        } catch (error) {
            console.error('Erro geral no envio:', error);
            addLog(`Erro geral no envio: ${error.message}`);
        } finally {
            campaignProgress.inProgress = false;
            campaignProgress.currentNumber = null;

            // Limpeza dos arquivos temporários enviados
            if (files && files.length > 0) {
                for (const file of files) {
                    try {
                        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
                        const ext = path.extname(file.originalname);
                        const newPath = file.path + (ext ? ext : '.jpg');
                        if (fs.existsSync(newPath)) fs.unlinkSync(newPath);
                    } catch (e) {}
                }
            }
        }
    })();
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${port}`);
});
