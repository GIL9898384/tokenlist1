
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Chaves da Agora (use variáveis de ambiente para segurança)
const APP_ID = process.env.AGORA_APP_ID || 'SUA_APP_ID_AQUI';
const APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE || 'SUA_APP_CERTIFICATE_AQUI';

// Gerador real de token da Agora
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');

function generateAgoraToken(channel, uid, role = RtcRole.PUBLISHER, expireSeconds = 3600) {
  if (!APP_ID || !APP_CERTIFICATE) {
    throw new Error('APP_ID e APP_CERTIFICATE da Agora não configurados');
  }
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpireTs = currentTimestamp + expireSeconds;
  return RtcTokenBuilder.buildTokenWithUid(
    APP_ID,
    APP_CERTIFICATE,
    channel,
    Number(uid),
    role,
    privilegeExpireTs
  );
}

// Lista dinâmica de lives (armazenada em memória)
let livesBase = [];

// Endpoint para registrar uma nova live (POST)
app.use(express.json());
app.post('/lives', (req, res) => {
  const live = req.body;
  if (!live || !live.id || !live.streamerId || !live.name || !live.imageUrl || !live.agoraChannel || !live.streamerUid) {
    return res.status(400).json({ error: 'Dados obrigatórios ausentes.' });
  }
  // Evita duplicidade de id
  if (livesBase.some(l => l.id === live.id)) {
    return res.status(409).json({ error: 'Live com esse id já existe.' });
  }
  livesBase.push(live);
  res.status(201).json({ success: true });
});

// Endpoint que retorna a lista de lives já com token gerado para cada uma
app.get('/lives', (req, res) => {
  try {
    // Para cada live, gera um token real de publisher
    const livesWithToken = livesBase.map(live => ({
      ...live,
      agoraToken: generateAgoraToken(live.agoraChannel, live.streamerUid, RtcRole.PUBLISHER)
    }));
    res.json(livesWithToken);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint opcional para gerar token sob demanda (ex: para transmissão)
app.get('/generate-token', (req, res) => {
  const { channel, uid, role } = req.query;
  if (!channel || !uid) {
    return res.status(400).json({ error: 'channel e uid são obrigatórios' });
  }
  try {
    // role pode ser 'publisher' ou 'subscriber'
    const agoraRole = role === 'subscriber' ? RtcRole.SUBSCRIBER : RtcRole.PUBLISHER;
    const token = generateAgoraToken(channel, uid, agoraRole);
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
