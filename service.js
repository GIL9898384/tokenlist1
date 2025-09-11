const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// IMPORTANTE: Use variáveis de ambiente para suas chaves e NÃO inclua fallbacks inseguros.
const APP_ID = process.env.AGORA_APP_ID || 'b0f49e5d5d5e45ba94179b4465951612';
const APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;
// DEBUG: Mostra se as variáveis de ambiente estão presentes
console.log('DEBUG AGORA_APP_ID:', APP_ID ? '[OK]' : '[FALTANDO]');
console.log('DEBUG AGORA_APP_CERTIFICATE:', APP_CERTIFICATE ? '[OK]' : '[FALTANDO]');
console.log('DEBUG APP_ID value:', APP_ID);
console.log('DEBUG APP_CERTIFICATE value:', APP_CERTIFICATE ? 'PRESENTE' : 'AUSENTE');

// Gerador de token da Agora
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');

// Middleware para analisar o corpo da requisição JSON
app.use(express.json());

// Lista dinâmica de lives (armazenada em memória - usar DB para produção)
const livesBase = [];

/**
 * Gera um token da Agora para o canal e UID fornecidos.
 * @param {string} channel - Nome do canal.
 * @param {number} uid - UID do usuário.
 * @param {RtcRole} role - Papel do usuário (PUBLISHER ou SUBSCRIBER).
 * @param {number} expireSeconds - Tempo de expiração do token em segundos.
 * @returns {string} O token RTC.
 */
function generateAgoraToken(channel, uid, role = RtcRole.PUBLISHER, expireSeconds = 86400) {
  if (!APP_ID || !APP_CERTIFICATE) {
    throw new Error('APP_ID ou APP_CERTIFICATE da Agora não configurados nas variáveis de ambiente.');
  }
  // DEBUG: Mostra parâmetros de geração de token
  console.log('[DEBUG TOKEN] channel:', channel, '| uid:', uid, '| role:', role === RtcRole.PUBLISHER ? 'PUBLISHER' : 'SUBSCRIBER', '| expireSeconds:', expireSeconds);
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpireTs = currentTimestamp + expireSeconds;
  
  console.log('[DEBUG TOKEN] Timestamps - current:', currentTimestamp, '| expire:', privilegeExpireTs);
  
  const token = RtcTokenBuilder.buildTokenWithUid(
    APP_ID,
    APP_CERTIFICATE,
    channel,
    Number(uid),
    role,
    privilegeExpireTs
  );
  
  if (!token) {
    console.error('[DEBUG TOKEN] Token retornou vazio!');
  } else {
    console.log('[DEBUG TOKEN] Token gerado com sucesso! Length:', token.length);
  }
  return token;
}

// ------------------------------------------------------------------
// Endpoint para o espectador obter um token de viewer para uma live específica
app.get('/lives/:id/token/viewer', (req, res) => {
  const { id } = req.params;
  const { uid } = req.query;
  
  console.log(`[TOKEN REQUEST] Buscando live: ${id} para viewer UID: ${uid}`);
  console.log(`[TOKEN REQUEST] Lives disponíveis: ${livesBase.map(l => l.id).join(', ')}`);
  
  // Validação do UID
  if (!uid || isNaN(Number(uid))) {
    console.error(`[TOKEN ERROR] UID inválido: ${uid}`);
    return res.status(400).json({ error: 'UID deve ser um número válido.' });
  }
  
  const live = livesBase.find(l => l.id === id);

  if (!live) {
    console.error(`[TOKEN ERROR] Live ${id} não encontrada!`);
    return res.status(404).json({ error: 'Live não encontrada.' });
  }

  console.log(`[TOKEN REQUEST] Live encontrada: ${live.name} | Canal: ${live.agoraChannel} | StreamerUID: ${live.streamerUid}`);

  try {
    const token = generateAgoraToken(live.agoraChannel, Number(uid), RtcRole.SUBSCRIBER);
    console.log(`[TOKEN SUCCESS] Token gerado para viewer UID: ${uid} no canal: ${live.agoraChannel}`);
    res.json({ token, uid: Number(uid), channel: live.agoraChannel });
    console.log(`Token SUBSCRIBER gerado para a live: ${live.name} | viewerUid: ${uid}`);
  } catch (err) {
    console.error('Erro ao gerar token de viewer:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ENDPOINTS
// ------------------------------------------------------------------

// Endpoint para registrar uma nova live (POST)
// NOTA: Este endpoint APENAS CRIA a entrada da live. O token do streamer
// será gerado separadamente sob demanda, garantindo que seja sempre fresco.
app.post('/lives', (req, res) => {
  const { id, streamerId, name, imageUrl, agoraChannel, streamerUid } = req.body;
  if (!id || !streamerId || !name || !imageUrl || !agoraChannel || !streamerUid) {
    return res.status(400).json({ error: 'Dados obrigatórios ausentes.' });
  }
  
  // Evita duplicidade de ID
  if (livesBase.some(l => l.id === id)) {
    return res.status(409).json({ error: 'Live com esse id já existe.' });
  }

  const newLive = { id, streamerId, name, imageUrl, agoraChannel, streamerUid, lastHeartbeat: Math.floor(Date.now() / 1000) };
  livesBase.push(newLive);
  console.log(`Live registrada: ${name} no canal ${agoraChannel}`);
  res.status(201).json({ success: true, live: newLive });
});

// Endpoint para o streamer obter um token fresco para iniciar a live
// Ele precisa fornecer o ID da live para que o servidor possa validá-la.
app.get('/lives/:id/token/publisher', (req, res) => {
  const { id } = req.params;
  const live = livesBase.find(l => l.id === id);

  if (!live) {
    return res.status(404).json({ error: 'Live não encontrada.' });
  }

  try {
    const token = generateAgoraToken(live.agoraChannel, live.streamerUid, RtcRole.PUBLISHER);
    res.json({ token, uid: live.streamerUid, channel: live.agoraChannel });
    console.log(`Token PUBLISHER gerado para a live: ${live.name}`);
  } catch (err) {
    console.error('Erro ao gerar token:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint que retorna a lista de lives para o espectador, com um token de SUBSCRIBER
app.get('/lives', (req, res) => {
  try {
    // Para filtrar apenas lives ativas (últimos 90s), descomente abaixo:
    // const now = Math.floor(Date.now() / 1000);
    // const activeLives = livesBase.filter(live => {
    //   return (now - (live.lastHeartbeat || 0)) < 90;
    // });
    // res.json(activeLives);
    // console.log('Lista de lives enviada para o espectador. Ativas:', activeLives.length);

    // Atualmente retorna todas as lives (inclui fake):
    res.json(livesBase);
    console.log('Lista de lives enviada para o espectador. Total:', livesBase.length);
  } catch (err) {
    console.error('Erro ao listar lives:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint para encerrar/remover uma live
app.delete('/lives/:id', (req, res) => {
  const { id } = req.params;
  const index = livesBase.findIndex(l => l.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Live não encontrada.' });
  }
  const liveName = livesBase[index].name;
  livesBase.splice(index, 1);
  console.log(`Live encerrada: ${liveName}`);
  res.json({ success: true });
});

// Live fake fixa para testes e navegação sem precisar iniciar uma live real
// Remova ou comente este bloco quando não precisar mais da live fake
livesBase.push({
  id: '1756687168364',
  streamerId: '1756687168364',
  name: 'yure Ráda 🐈',
  imageUrl: 'https://randomuser.me/api/portraits/men/32.jpg',
  agoraChannel: 'canal_fake',
  streamerUid: 123456,
  lastHeartbeat: Math.floor(Date.now() / 1000)
});

// Inicialização do servidor
// Endpoint para receber heartbeat da live
app.post('/lives/:id/heartbeat', (req, res) => {
  const { id } = req.params;
  const live = livesBase.find(l => l.id === id);
  if (!live) {
    return res.status(404).json({ error: 'Live não encontrada.' });
  }
  live.lastHeartbeat = Math.floor(Date.now() / 1000);
  res.json({ success: true, lastHeartbeat: live.lastHeartbeat });
});
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  if (!APP_ID || !APP_CERTIFICATE) {
    console.warn('AVISO: As chaves da Agora não estão configuradas. O servidor pode falhar ao gerar tokens.');
  }
  
  console.log('[INIT] Servidor de lives iniciado. Lives serão criadas dinamicamente pelos streamers.');
  console.log('[INIT] Use POST /lives para criar uma nova live.');
  console.log('[INIT] Use GET /lives para listar lives ativas.');
});
