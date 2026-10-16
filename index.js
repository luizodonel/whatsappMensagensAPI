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

// WhatsApp Client
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        executablePath: detectedExecPath,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process'
        ]
    }
});

const logs = [];
function addLog(msg) {
    const entry = `[${new Date().toISOString()}] ${msg}`;
    console.log(entry);
    logs.push(entry);
    if (logs.length > 100) logs.shift();
}

let qrCodeData = null;
let isConnected = false;
let campaignProgress = {
    total: 0,
    sent: 0,
    currentNumber: null,
    inProgress: false
};

client.on('loading_screen', (percent, message) => {
    addLog(`Loading screen: ${percent}% - ${message}`);
});

client.on('qr', (qr) => {
    addLog('QR Code gerado com sucesso!');
    qrcode.generate(qr, { small: true });
    qrCodeData = qr;
});

client.on('authenticated', () => {
    addLog('WhatsApp autenticado com sucesso!');
});

client.on('auth_failure', (msg) => {
    addLog(`Falha de autenticação: ${msg}`);
});

client.on('ready', () => {
    addLog('WhatsApp está pronto (ready)!');
    isConnected = true;
    qrCodeData = null;
});

client.on('disconnected', (reason) => {
    addLog(`WhatsApp desconectado: ${reason}`);
    isConnected = false;
});

const repliedContactsFile = path.join(__dirname, 'replied.json');
if (!fs.existsSync(repliedContactsFile)) {
    fs.writeFileSync(repliedContactsFile, JSON.stringify([]));
}

client.on('message', async msg => {
    // Ignora mensagens de grupos ou status
    if (msg.from.includes('@g.us') || msg.from === 'status@broadcast') return;
    
    // Ignora mensagens enviadas por você mesmo
    if (msg.fromMe) return;

    try {
        const repliedContacts = JSON.parse(fs.readFileSync(repliedContactsFile, 'utf8'));
        
        // Se já respondemos a essa pessoa, ignoramos
        if (repliedContacts.includes(msg.from)) return;
        
        // Função de delay local
        const sleep = (ms) => new Promise(res => setTimeout(res, ms));
        
        // Simular que está digitando para parecer mais humano
        try {
            const chat = await msg.getChat();
            await chat.sendStateTyping();
            await sleep(3000); // Aguarda 3 segundos digitando
            await chat.clearState();
        } catch (e) {
            console.log('Não foi possível simular digitação (erro do wwebjs):', e.message);
        }
        
        const replyMsg = "Que ótimo! 🚀\n\nAqui está o seu link de acesso exclusivo para ver como a ferramenta funciona na prática. Aproveite enquanto o sistema ainda está com os testes liberados:\n\n👉 https://www.sinaiscassino.com.br\n\nSe tiver qualquer dúvida sobre a plataforma, é só me chamar por aqui!";
        await msg.reply(replyMsg);
        
        // Salva que já enviamos para não mandar de novo
        repliedContacts.push(msg.from);
        fs.writeFileSync(repliedContactsFile, JSON.stringify(repliedContacts, null, 2));
        console.log(`Auto-resposta com link enviada para ${msg.from}`);
    } catch (err) {
        console.error('Erro na auto-resposta:', err);
    }
});

addLog(`Executável detectado: ${detectedExecPath || 'padrão (Puppeteer Cache)'}`);
addLog('Chamando client.initialize()...');
client.initialize().then(() => {
    addLog('client.initialize() concluído com sucesso.');
}).catch(err => {
    addLog(`ERRO em client.initialize(): ${err.message || err}`);
    console.error('Erro ao inicializar WhatsApp Client:', err);
});

// Routes
app.get('/api/status', (req, res) => {
    res.json({
        connected: isConnected,
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
        await client.initialize();
        res.json({ success: true, message: 'Inicialização disparada com sucesso' });
    } catch (e) {
        addLog(`Falha no retry: ${e.message}`);
        res.status(500).json({ success: false, error: e.message });
    }
});

const delay = (ms) => new Promise(res => setTimeout(res, ms));

app.post('/api/send', upload.array('images'), async (req, res) => {
    if (!isConnected) {
        return res.status(400).json({ error: 'WhatsApp is not connected' });
    }

    if (campaignProgress.inProgress) {
        return res.status(400).json({ error: 'A campaign is already running' });
    }

    const { description, link } = req.body;
    const files = req.files;

    try {
        // Load contacts
        const contactsPath = path.join(__dirname, 'contacts.json');
        const contacts = JSON.parse(fs.readFileSync(contactsPath, 'utf8'));

        console.log(`Starting campaign to ${contacts.length} contacts...`);
        
        campaignProgress = {
            total: contacts.length,
            sent: 0,
            currentNumber: null,
            inProgress: true
        };
        
        // Respond to frontend immediately, and process in background
        res.json({ message: 'Campaign started', total: contacts.length });

        const spintaxMessages = [
            "Olá! 🚀 Conheça nossa nova plataforma 100% gratuita! Aqui você tem acesso a sinais de cassino 100% grátis e pode jogar direto na plataforma, sem complicações. Para acessar agora, é só clicar neste link:\n👉 https://www.sinaiscassino.com.br",
            "Oi! 🎁 Sabia que agora temos uma plataforma 100% gratuita? Nela você recebe sinais de cassino totalmente grátis e já pode jogar direto pelo próprio sistema. Clique no link para conferir:\n👉 https://www.sinaiscassino.com.br",
            "Tudo bem? 💰 Descubra a nossa plataforma 100% gratuita! Receba sinais de cassino 100% grátis em tempo real e jogue direto dentro do nosso ambiente. Para testar na prática, é só acessar o link:\n👉 https://www.sinaiscassino.com.br",
            "Boa notícia! 🎉 Liberamos uma plataforma 100% gratuita onde você pega sinais de cassino totalmente grátis e consegue jogar direto por lá. É tudo em um só lugar. Acesse agora clicando no link:\n👉 https://www.sinaiscassino.com.br",
            "Olá! 🏆 Venha conhecer a nossa plataforma que é 100% gratuita! Você vai ter acesso a sinais de cassino 100% grátis e a facilidade de jogar direto na plataforma. Para liberar o seu acesso, basta clicar no link:\n👉 https://www.sinaiscassino.com.br",
            "Oi! 📊 Estamos com uma plataforma 100% gratuita incrível. Lá você tem sinais de cassino 100% grátis e joga diretamente na plataforma. Quer ver como é? É só clicar no link e acessar:\n👉 https://www.sinaiscassino.com.br"
        ];

        for (let i = 0; i < contacts.length; i++) {
            const number = contacts[i];
            const formattedNumber = `55${number}@c.us`; // Formatting for whatsapp-web.js (adding 55 for Brazil country code to numbers that are already cleaned to just the area code and number)
            // Wait, the numbers in my script were full numbers including 55. Let's check `clean_numbers.js` output.
            // Oh, the output is `558288961063`. So it already has 55. 
            // We just need `${number}@c.us`. I will fix this locally below.
            
            campaignProgress.currentNumber = number;

            try {
                // Resolve the correct WhatsApp ID (handles Brazilian 9th digit issue)
                let whatsappId;
                try {
                    const contactId = await client.getNumberId(number);
                    if (!contactId) {
                        console.error(`Number not registered on WhatsApp: ${number}`);
                        fs.appendFileSync(path.join(__dirname, 'erros_envio.txt'), `${number} - Não registrado no WhatsApp\n`);
                        
                        // Remove o número da lista para não tentar novamente
                        let currentContacts = JSON.parse(fs.readFileSync(contactsPath, 'utf8'));
                        currentContacts = currentContacts.filter(n => n !== number);
                        fs.writeFileSync(contactsPath, JSON.stringify(currentContacts, null, 2));
                        
                        continue;
                    }
                    whatsappId = contactId._serialized;
                } catch (err) {
                    console.warn(`getNumberId falhou para ${number} (${err.message}). Usando formato direto.`);
                    whatsappId = `${number}@c.us`;
                }

                const mensagemSelecionada = spintaxMessages[i % spintaxMessages.length];

                // 1. Send Images (with message as caption on the last image)
                if (files && files.length > 0) {
                    for (let j = 0; j < files.length; j++) {
                        const file = files[j];
                        
                        // Renomear o arquivo para ter a extensão original, pois o WWebJS precisa dela
                        const ext = path.extname(file.originalname);
                        const newPath = file.path + (ext ? ext : '.jpg');
                        if (!fs.existsSync(newPath)) {
                            fs.copyFileSync(file.path, newPath);
                        }
                        
                        const media = MessageMedia.fromFilePath(newPath);
                        
                        if (j === files.length - 1) {
                            // Última imagem recebe a mensagem como legenda
                            await client.sendMessage(whatsappId, media, { caption: mensagemSelecionada });
                        } else {
                            await client.sendMessage(whatsappId, media);
                        }
                        await delay(2000);
                    }
                } else {
                    // Sem imagens, apenas envia o texto
                    await client.sendMessage(whatsappId, mensagemSelecionada);
                    await delay(2000);
                }
                
                campaignProgress.sent++;
                console.log(`[${i + 1}/${contacts.length}] Sent to ${number}`);

                // Remove o número da lista após o envio com sucesso
                let currentContacts = JSON.parse(fs.readFileSync(contactsPath, 'utf8'));
                currentContacts = currentContacts.filter(n => n !== number);
                fs.writeFileSync(contactsPath, JSON.stringify(currentContacts, null, 2));
            } catch (err) {
                console.error(`Error sending to ${number}:`, err.message);
                fs.appendFileSync(path.join(__dirname, 'erros_envio.txt'), `${number} - Erro: ${err.message}\n`);
            }

            if (i < contacts.length - 1) {
                // Intervalo de 1 minuto a 1 minuto e 30 segundos (60000ms a 90000ms)
                const waitTime = Math.floor(Math.random() * 30000) + 60000;
                console.log(`Aguardando ${(waitTime / 60000).toFixed(2)} minutos para a próxima mensagem...`);
                await delay(waitTime);
            }
        }

        console.log('Campaign finished!');
        campaignProgress.inProgress = false;
        
        // Cleanup uploaded files
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

    } catch (error) {
        console.error('Campaign error:', error);
        campaignProgress.inProgress = false;
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${port}`);
});
