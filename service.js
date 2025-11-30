const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});
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

// Lista dinâmica de lives REAIS (armazenada em memória - usar DB para produção)
const livesBase = [];

// Lista de lives FAKE para testes (separada das reais)
const fakeLivesBase = [];

// ======================= ESTRUTURAS PK =======================
const pkSessions = {}; // { pkId: { hostLiveId, challengerLiveId, hostScore, challengerScore, state, startTime, duration } }
const livePK = {}; // { liveId: pkId } - mapeia liveId para pkId ativo

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
  console.log(`[TOKEN REQUEST] Lives REAIS disponíveis: ${livesBase.map(l => l.id).join(', ')}`);
  console.log(`[TOKEN REQUEST] Lives FAKE disponíveis: ${fakeLivesBase.map(l => l.id).join(', ')}`);
  
  // Validação do UID
  if (!uid || isNaN(Number(uid))) {
    console.error(`[TOKEN ERROR] UID inválido: ${uid}`);
    return res.status(400).json({ error: 'UID deve ser um número válido.' });
  }
  
  // Busca primeiro nas lives reais, depois nas fake
  let live = livesBase.find(l => l.id === id);
  if (!live) {
    live = fakeLivesBase.find(l => l.id === id);
    if (live) {
      console.log(`[TOKEN REQUEST] Live encontrada na lista FAKE`);
    }
  } else {
    console.log(`[TOKEN REQUEST] Live encontrada na lista REAL`);
  }

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
  const { id, streamerId, name, imageUrl, agoraChannel, streamerUid, title, coverImageUrl } = req.body;
  if (!id || !streamerId || !name || !imageUrl || !agoraChannel || !streamerUid) {
    return res.status(400).json({ error: 'Dados obrigatórios ausentes.' });
  }
  
  // Evita duplicidade de ID
  if (livesBase.some(l => l.id === id)) {
    return res.status(409).json({ error: 'Live com esse id já existe.' });
  }

  const newLive = { 
    id, 
    streamerId, 
    name, 
    imageUrl, 
    agoraChannel, 
    streamerUid, 
    title: title || '', 
    coverImageUrl: coverImageUrl || null,
    lastHeartbeat: Math.floor(Date.now() / 1000) 
  };
  livesBase.push(newLive);
  console.log(`Live registrada: ${name} no canal ${agoraChannel} - Título: ${title || 'Sem título'} - Capa: ${coverImageUrl ? 'Sim' : 'Não'}`);
  res.status(201).json({ success: true, live: newLive });
});

// Endpoint para o streamer obter um token fresco para iniciar a live
// Ele precisa fornecer o ID da live para que o servidor possa validá-la.
app.get('/lives/:id/token/publisher', (req, res) => {
  const { id } = req.params;
  // Busca primeiro nas lives reais, depois nas fake
  let live = livesBase.find(l => l.id === id);
  if (!live) {
    live = fakeLivesBase.find(l => l.id === id);
  }

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
    // Filtra apenas lives reais ativas (últimos 90s)
    const now = Math.floor(Date.now() / 1000);
    const realActiveLives = livesBase.filter(live => {
      return (now - (live.lastHeartbeat || 0)) < 90;
    });

    // Adiciona informações de PK às lives
    const addPKInfo = (lives) => {
      return lives.map(live => {
        const pkId = livePK[live.id];
        const hasPK = !!pkId;
        let pkStatus = null;
        
        if (hasPK && pkSessions[pkId]) {
          pkStatus = pkSessions[pkId].state;
        }
        
        return {
          ...live,
          hasPK,
          pkStatus
        };
      });
    };

    // Se houver lives reais ativas, retorna só elas
    if (realActiveLives.length > 0) {
      const livesWithPK = addPKInfo(realActiveLives);
      res.json(livesWithPK);
      console.log(`[LIVES] Lives REAIS retornadas: ${realActiveLives.length}`);
      console.log(`[LIVES] IDs: ${realActiveLives.map(l => l.id).join(', ')}`);
    } else {
      // Se não houver lives reais, retorna as fake para teste
      const fakeLivesWithPK = addPKInfo(fakeLivesBase);
      res.json(fakeLivesWithPK);
      console.log(`[LIVES] Nenhuma live real ativa. Retornando ${fakeLivesBase.length} lives FAKE para teste.`);
    }
    
    // TODO: Implementar evento de popup para aceitar batalha PK
    // Sistema de notificação em tempo real (WebSocket ou polling)
    // Quando um streamer recebe convite de PK, deve aparecer popup com opções aceitar/recusar
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
const fakeCovers = [
  'https://res.aliiparty.com/room/cover/10417590-7a70774e79484159a30fc052e793dab8.jpg?v=1760990123405',
  'https://res.aliiparty.com/room/cover/10986758-08c51df479da4a6b984e4848040b5750.jpg?v=1761387808035',
  'https://res.aliiparty.com/room/cover/10527283-b2ca40f5df9043d4a110782bd06664c2.jpg?v=1761258249738',
  'https://res.aliiparty.com/room/cover/10048055-c92e18ca9f31436caf459ea2d0e43698.jpg?v=1761175676668',
  'https://res.aliiparty.com/room/cover/10908744-cd4ef4694b6746b0b25aacb2a666bac2.jpg?v=1761257141374',
  'https://res.aliiparty.com/room/cover/10768883-f0866b7022ad4f1eaade56f74f116bbc.jpg?v=1759290950001',
  'https://res.aliiparty.com/photo/10433920/1754732169618.jpg',
  'https://res.aliiparty.com/room/cover/10911643-9a39fe0fc76b42aea2a710cda64db58d.jpg?v=1760483497655',
  'https://res.aliiparty.com/room/cover/10473945-cde796f5f125444e83db0c0652ef8642.jpg?v=1761040245937',
  'https://res.aliiparty.com/photo/10587329/508a0bfd410b4a4a95b6b18754fddd51.jpg',
  'https://res.aliiparty.com/photo/10484904/1746119393613.jpg',
  'https://res.aliiparty.com/photo/10962731/1752779021387.jpg?v=1752779021387',
  'https://res.aliiparty.com/room/cover/10112057-554fddbf32524ada8a8aef0d493f2229.jpg?v=1758068486190',
  'https://res.aliiparty.com/room/cover/10414689-2416f939b4d14defb8e1788b5c6ccc44.jpg?v=1756579161658',
  'https://res.aliiparty.com/room/cover/10954016-07fe82170bb24cc0b850044182577ef5.jpg?v=1760740366400',
  'https://res.aliiparty.com/room/cover/10580786-1501ff805c3047fba3b870af007021cf.jpg?v=1760391201415',
  'https://res.aliiparty.com/room/cover/10586496-11d5c93969b5449bbc8517ff7871208e.jpg?v=1760102764423',
  'https://res.aliiparty.com/room/cover/10416142-56a7d03229e44721a56162c5e3605a51.jpg?v=1759785375680',
  'https://res.aliiparty.com/room/cover/10539051-001c99e7470f4310813fb5bcbc82d4cb.jpg?v=1760468127375',
  'https://res.aliiparty.com/room/cover/10482736-46bf12928cce470384226afe5619539c.jpg?v=1757524131582',
  'https://res.aliiparty.com/photo/10232772/1757038830975.jpg',
  'https://res.aliiparty.com/room/cover/10947270-c904e93893204068bc8e6ed7f19b6f73.jpg?v=1761310563073',
  'https://res.aliiparty.com/photo/10752652/12c5642649dd4e1f804a540dcd5c8f17.jpg',
  'https://res.aliiparty.com/room/cover/10871722-8eb4f04a4e58462b94758f99851203ae.jpg?v=1760201746605',
  'https://res.aliiparty.com/room/cover/10543499-927852810cb24c8fab8cfccf4d6e554a.jpg?v=1760650765844'
];

const fakeNames = ['Lander 🎯', 'Maria 💖', 'João 🎮', 'Ana 🌟', 'Pedro 🔥', 'Julia 💎', 'Lucas 😎', 'Camila 🌸', 'Rafael 🚀', 'Beatriz 💕', 'Gabriel 🎵', 'Larissa 🦋', 'Felipe 💪', 'Amanda 🌺', 'Thiago 🎯', 'Isabela 👑', 'Diego 🏆', 'Fernanda 🌙', 'Bruno 🎸', 'Leticia 💋', 'Rodrigo ⚡', 'Gabriela 🌹', 'Vinicius 🎭', 'Carolina 🍀', 'Leonardo 🌊', 'Patricia 💫'];

const fakeTitles = ['os melhores do ano 😇', 'Conversando com vocês! 💬', 'Bate-papo ao vivo 🎙️', 'Interação com os seguidores ✨', 'Respondendo perguntas 💭', 'Live tranquila 🌿', 'Jogando com os amigos 🎮', 'Cantando suas músicas 🎤', 'Mostrando meu dia 📸', 'Fazendo tutorial 📚', 'Desafios e brincadeiras 🎲', 'Conhecendo vocês melhor 💕', 'Compartilhando dicas 💡', 'Sessão de perguntas ❓', 'Hora do café ☕', 'Papo descontraído 😄', 'Contando histórias 📖', 'Novidades e updates 🆕', 'Agradecendo o carinho 🙏', 'Live especial 🎁', 'Curtindo com vocês 🎉', 'Música ao vivo 🎵', 'Divulgando projetos 🎬', 'Relaxando juntos 🌅', 'Festa virtual 🎊', 'Encontro com fãs 💖'];

// Popula lista de lives FAKE (só para teste quando não há lives reais)
fakeCovers.forEach((cover, index) => {
  // Usa fotos aleatórias do randomuser.me para todos
  const profilePic = `https://randomuser.me/api/portraits/${index % 2 === 0 ? 'women' : 'men'}/${(index % 50) + 1}.jpg`;
  
  fakeLivesBase.push({
    id: `fake_live_${10000 + index}`,
    streamerId: `fake_streamer_${10000 + index}`,
    name: fakeNames[index],
    imageUrl: profilePic,
    agoraChannel: `canal_fake_${index}`,
    streamerUid: 123456 + index,
    title: fakeTitles[index],
    coverImageUrl: cover,
    lastHeartbeat: Math.floor(Date.now() / 1000)
  });
});

console.log(`[INIT] ${fakeLivesBase.length} lives FAKE carregadas para fallback (só aparecem quando não há lives reais).`);

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

// ======================= ENDPOINTS PK =======================

// Endpoint para enviar convite de PK
app.post('/pk/invite', (req, res) => {
  const { hostLiveId, challengerLiveId, duration = 300 } = req.body;
  
  if (!hostLiveId || !challengerLiveId) {
    return res.status(400).json({ error: 'hostLiveId e challengerLiveId são obrigatórios' });
  }

  const pkId = `pk_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  pkSessions[pkId] = {
    pkId,
    hostLiveId,
    challengerLiveId,
    hostScore: 0,
    challengerScore: 0,
    state: 'pending',
    duration,
    startTime: null,
    endTime: null,
    createdAt: Date.now()
  };

  console.log(`[PK_INVITE] Host ${hostLiveId} convida ${challengerLiveId} - pkId: ${pkId}`);
  
  res.json({ success: true, pkId, state: 'pending' });
});

// Endpoint para aceitar PK
app.post('/pk/:pkId/accept', (req, res) => {
  const { pkId } = req.params;
  const pk = pkSessions[pkId];

  if (!pk) {
    return res.status(404).json({ error: 'PK não encontrado' });
  }

  if (pk.state !== 'pending') {
    return res.status(400).json({ error: 'PK não está pendente' });
  }

  pk.state = 'active';
  pk.startTime = Date.now();
  pk.endTime = pk.startTime + (pk.duration * 1000);

  livePK[pk.hostLiveId] = pkId;
  livePK[pk.challengerLiveId] = pkId;

  // Busca dados das lives para retornar informações completas
  const hostLive = livesBase.find(l => l.id === pk.hostLiveId) || fakeLivesBase.find(l => l.id === pk.hostLiveId);
  const challengerLive = livesBase.find(l => l.id === pk.challengerLiveId) || fakeLivesBase.find(l => l.id === pk.challengerLiveId);

  if (!hostLive || !challengerLive) {
    return res.status(404).json({ error: 'Uma das lives não foi encontrada' });
  }

  console.log(`[PK_ACCEPT] PK ${pkId} iniciado - Host: ${pk.hostLiveId} vs Challenger: ${pk.challengerLiveId}`);

  // Agenda fim automático
  setTimeout(() => {
    if (pkSessions[pkId] && pkSessions[pkId].state === 'active') {
      endPK(pkId, 'timeout');
    }
  }, pk.duration * 1000);

  res.json({
    success: true,
    pkId,
    state: 'active',
    hostScore: pk.hostScore,
    challengerScore: pk.challengerScore,
    endTime: pk.endTime,
    duration: pk.duration,
    // Dados completos para o app renderizar
    host: {
      liveId: hostLive.id,
      streamerId: hostLive.streamerId,
      name: hostLive.name,
      imageUrl: hostLive.imageUrl,
      agoraChannel: hostLive.agoraChannel,
      streamerUid: hostLive.streamerUid
    },
    challenger: {
      liveId: challengerLive.id,
      streamerId: challengerLive.streamerId,
      name: challengerLive.name,
      imageUrl: challengerLive.imageUrl,
      agoraChannel: challengerLive.agoraChannel,
      streamerUid: challengerLive.streamerUid
    }
  });
});

// Endpoint para rejeitar PK
app.post('/pk/:pkId/reject', (req, res) => {
  const { pkId } = req.params;
  const pk = pkSessions[pkId];

  if (!pk) {
    return res.status(404).json({ error: 'PK não encontrado' });
  }

  console.log(`[PK_REJECT] PK ${pkId} rejeitado`);
  delete pkSessions[pkId];

  res.json({ success: true, message: 'PK rejeitado' });
});

// Endpoint para encerrar PK
app.post('/pk/:pkId/end', (req, res) => {
  const { pkId } = req.params;
  const result = endPK(pkId, 'manual');

  if (!result) {
    return res.status(404).json({ error: 'PK não encontrado' });
  }

  res.json(result);
});

// Endpoint para atualizar score do PK (quando gift é enviado)
app.post('/pk/:pkId/score', (req, res) => {
  const { pkId } = req.params;
  const { liveId, coins } = req.body;

  const pk = pkSessions[pkId];
  if (!pk || pk.state !== 'active') {
    return res.status(404).json({ error: 'PK não encontrado ou não está ativo' });
  }

  if (liveId === pk.hostLiveId) {
    pk.hostScore += coins;
  } else if (liveId === pk.challengerLiveId) {
    pk.challengerScore += coins;
  } else {
    return res.status(400).json({ error: 'liveId não pertence a este PK' });
  }

  console.log(`[PK_SCORE] PK ${pkId} - Host: ${pk.hostScore} vs Challenger: ${pk.challengerScore}`);

  res.json({
    success: true,
    pkId,
    hostScore: pk.hostScore,
    challengerScore: pk.challengerScore
  });
});

// Endpoint para obter status do PK
app.get('/pk/:pkId', (req, res) => {
  const { pkId } = req.params;
  const pk = pkSessions[pkId];

  if (!pk) {
    return res.status(404).json({ error: 'PK não encontrado' });
  }

  res.json({
    pkId: pk.pkId,
    hostLiveId: pk.hostLiveId,
    challengerLiveId: pk.challengerLiveId,
    hostScore: pk.hostScore,
    challengerScore: pk.challengerScore,
    state: pk.state,
    startTime: pk.startTime,
    endTime: pk.endTime,
    duration: pk.duration
  });
});

// Endpoint para obter PK ativo de uma live
app.get('/lives/:liveId/pk', (req, res) => {
  const { liveId } = req.params;
  const pkId = livePK[liveId];

  if (!pkId) {
    return res.json({ hasPK: false });
  }

  const pk = pkSessions[pkId];
  if (!pk) {
    delete livePK[liveId];
    return res.json({ hasPK: false });
  }

  // Busca dados das lives
  const hostLive = livesBase.find(l => l.id === pk.hostLiveId) || fakeLivesBase.find(l => l.id === pk.hostLiveId);
  const challengerLive = livesBase.find(l => l.id === pk.challengerLiveId) || fakeLivesBase.find(l => l.id === pk.challengerLiveId);

  res.json({
    hasPK: true,
    pkId: pk.pkId,
    hostScore: pk.hostScore,
    challengerScore: pk.challengerScore,
    state: pk.state,
    startTime: pk.startTime,
    endTime: pk.endTime,
    duration: pk.duration,
    isHost: liveId === pk.hostLiveId,
    // Dados completos para renderizar
    host: hostLive ? {
      liveId: hostLive.id,
      streamerId: hostLive.streamerId,
      name: hostLive.name,
      imageUrl: hostLive.imageUrl,
      agoraChannel: hostLive.agoraChannel,
      streamerUid: hostLive.streamerUid
    } : null,
    challenger: challengerLive ? {
      liveId: challengerLive.id,
      streamerId: challengerLive.streamerId,
      name: challengerLive.name,
      imageUrl: challengerLive.imageUrl,
      agoraChannel: challengerLive.agoraChannel,
      streamerUid: challengerLive.streamerUid
    } : null
  });
});

// Endpoint para viewer obter tokens de AMBOS os canais do PK
app.get('/pk/:pkId/tokens', (req, res) => {
  const { pkId } = req.params;
  const { uid } = req.query;

  if (!uid || isNaN(Number(uid))) {
    return res.status(400).json({ error: 'UID deve ser um número válido' });
  }

  const pk = pkSessions[pkId];
  if (!pk) {
    return res.status(404).json({ error: 'PK não encontrado' });
  }

  const hostLive = livesBase.find(l => l.id === pk.hostLiveId) || fakeLivesBase.find(l => l.id === pk.hostLiveId);
  const challengerLive = livesBase.find(l => l.id === pk.challengerLiveId) || fakeLivesBase.find(l => l.id === pk.challengerLiveId);

  if (!hostLive || !challengerLive) {
    return res.status(404).json({ error: 'Uma das lives não foi encontrada' });
  }

  try {
    // Gera tokens para ambos os canais
    const hostToken = generateAgoraToken(hostLive.agoraChannel, Number(uid), RtcRole.SUBSCRIBER);
    const challengerToken = generateAgoraToken(challengerLive.agoraChannel, Number(uid), RtcRole.SUBSCRIBER);

    console.log(`[PK_TOKENS] Tokens gerados para viewer UID ${uid} no PK ${pkId}`);

    res.json({
      success: true,
      pkId,
      viewerUid: Number(uid),
      host: {
        channel: hostLive.agoraChannel,
        token: hostToken,
        streamerUid: hostLive.streamerUid,
        name: hostLive.name,
        imageUrl: hostLive.imageUrl
      },
      challenger: {
        channel: challengerLive.agoraChannel,
        token: challengerToken,
        streamerUid: challengerLive.streamerUid,
        name: challengerLive.name,
        imageUrl: challengerLive.imageUrl
      }
    });
  } catch (err) {
    console.error('[PK_TOKENS] Erro ao gerar tokens:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Função helper para encerrar PK
function endPK(pkId, reason = 'manual') {
  const pk = pkSessions[pkId];
  if (!pk) return null;

  const winner = pk.hostScore > pk.challengerScore 
    ? 'host' 
    : pk.challengerScore > pk.hostScore 
      ? 'challenger' 
      : 'draw';

  console.log(`[PK_END] PK ${pkId} encerrado - Winner: ${winner} (${reason})`);

  delete livePK[pk.hostLiveId];
  delete livePK[pk.challengerLiveId];
  delete pkSessions[pkId];

  return {
    success: true,
    pkId,
    winner,
    hostScore: pk.hostScore,
    challengerScore: pk.challengerScore,
    reason
  };
}

// ======================= SOCKET.IO EVENTS =======================
const liveRooms = {}; // { liveId: Set<socketId> }

io.on('connection', (socket) => {
  console.log(`[SOCKET] Cliente conectado: ${socket.id}`);

  // Entrar na sala da live
  socket.on('join_live', (liveId) => {
    socket.join(`live_${liveId}`);
    if (!liveRooms[liveId]) {
      liveRooms[liveId] = new Set();
    }
    liveRooms[liveId].add(socket.id);
    console.log(`[SOCKET] ${socket.id} entrou na live ${liveId}`);
  });

  // Sair da sala da live
  socket.on('leave_live', (liveId) => {
    socket.leave(`live_${liveId}`);
    if (liveRooms[liveId]) {
      liveRooms[liveId].delete(socket.id);
    }
    console.log(`[SOCKET] ${socket.id} saiu da live ${liveId}`);
  });

  socket.on('disconnect', () => {
    // Remove de todas as salas
    Object.keys(liveRooms).forEach(liveId => {
      if (liveRooms[liveId]) {
        liveRooms[liveId].delete(socket.id);
      }
    });
    console.log(`[SOCKET] Cliente desconectado: ${socket.id}`);
  });
});

// ======================= PK ENDPOINTS COM WEBSOCKET =======================

// Enviar convite PK
app.post('/pk/invite', async (req, res) => {
  try {
    const { challengerLiveId, targetLiveId } = req.body;

    if (!challengerLiveId || !targetLiveId) {
      return res.status(400).json({ error: 'challengerLiveId e targetLiveId são obrigatórios' });
    }

    // Verifica se as lives existem
    const challengerLive = livesBase.find(l => l.id === challengerLiveId) || fakeLivesBase.find(l => l.id === challengerLiveId);
    const targetLive = livesBase.find(l => l.id === targetLiveId) || fakeLivesBase.find(l => l.id === targetLiveId);

    if (!challengerLive || !targetLive) {
      return res.status(404).json({ error: 'Uma ou ambas as lives não foram encontradas' });
    }

    // Verifica se alguma já está em PK
    if (livePK[challengerLiveId] || livePK[targetLiveId]) {
      return res.status(400).json({ error: 'Uma das lives já está em PK' });
    }

    // Cria sessão PK pendente
    const pkId = `pk_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    pkSessions[pkId] = {
      hostLiveId: challengerLiveId,
      challengerLiveId: targetLiveId,
      hostScore: 0,
      challengerScore: 0,
      state: 'pending',
      startTime: null,
      duration: 180 // 3 minutos padrão
    };

    // Mapeia ambas as lives ao PK
    livePK[challengerLiveId] = pkId;
    livePK[targetLiveId] = pkId;

    console.log(`[PK_INVITE] ${challengerLive.name} desafiou ${targetLive.name} - PK ID: ${pkId}`);

    // Envia notificação HTTP para o servidor de comentários WebSocket
    // que transmitirá o evento pk_invite para os clientes conectados
    const commentBackendUrl = 'https://comentario-9djx.onrender.com/broadcast';
    try {
      const axios = require('axios');
      await axios.post(commentBackendUrl, {
        streamId: targetLiveId,
        event: 'pk_invite',
        data: {
          pkId,
          challengerName: challengerLive.name,
          challengerImageUrl: challengerLive.imageUrl,
          challengerLiveId: challengerLiveId,
          targetLiveId: targetLiveId
        }
      }, {
        timeout: 5000
      });
      console.log(`[PK_INVITE] Notificação enviada para servidor de comentários`);
    } catch (err) {
      console.error(`[PK_INVITE] Erro ao notificar servidor de comentários: ${err.message}`);
      // Continua mesmo se falhar - o convite foi criado
    }

    // Envia evento WebSocket para a live alvo (Socket.IO local - se tiver clientes conectados aqui)
    io.to(`live_${targetLiveId}`).emit('pk_invite', {
      pkId,
      challengerName: challengerLive.name,
      challengerImageUrl: challengerLive.imageUrl,
      challengerLiveId: challengerLiveId,
      targetLiveId: targetLiveId
    });

    res.json({
      success: true,
      pkId,
      message: 'Convite enviado'
    });
  } catch (err) {
    console.error('[PK_INVITE] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Aceitar convite PK
app.post('/pk/:pkId/accept', (req, res) => {
  try {
    const { pkId } = req.params;
    const pk = pkSessions[pkId];

    if (!pk) {
      return res.status(404).json({ error: 'PK não encontrado' });
    }

    if (pk.state !== 'pending') {
      return res.status(400).json({ error: 'PK não está pendente' });
    }

    // Ativa o PK
    pk.state = 'active';
    pk.startTime = Date.now();

    console.log(`[PK_ACCEPT] PK ${pkId} aceito - Iniciando batalha`);

    // Notifica ambas as lives que o PK foi aceito
    io.to(`live_${pk.hostLiveId}`).emit('pk_accepted', {
      pkId,
      state: 'active',
      opponentLiveId: pk.challengerLiveId
    });

    io.to(`live_${pk.challengerLiveId}`).emit('pk_accepted', {
      pkId,
      state: 'active',
      opponentLiveId: pk.hostLiveId
    });

    res.json({
      success: true,
      pkId,
      state: 'active'
    });
  } catch (err) {
    console.error('[PK_ACCEPT] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Rejeitar convite PK
app.post('/pk/:pkId/reject', (req, res) => {
  try {
    const { pkId } = req.params;
    const pk = pkSessions[pkId];

    if (!pk) {
      return res.status(404).json({ error: 'PK não encontrado' });
    }

    console.log(`[PK_REJECT] PK ${pkId} rejeitado`);

    // Notifica o desafiante que foi rejeitado
    io.to(`live_${pk.hostLiveId}`).emit('pk_rejected', {
      pkId
    });

    // Remove o PK
    delete livePK[pk.hostLiveId];
    delete livePK[pk.challengerLiveId];
    delete pkSessions[pkId];

    res.json({
      success: true,
      message: 'Convite rejeitado'
    });
  } catch (err) {
    console.error('[PK_REJECT] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  if (!APP_ID || !APP_CERTIFICATE) {
    console.warn('AVISO: As chaves da Agora não estão configuradas. O servidor pode falhar ao gerar tokens.');
  }
  
  console.log('[INIT] Servidor de lives iniciado. Lives serão criadas dinamicamente pelos streamers.');
  console.log('[INIT] Use POST /lives para criar uma nova live.');
  console.log('[INIT] Use GET /lives para listar lives ativas.');
  console.log('[INIT] Socket.IO configurado para eventos em tempo real.');
});
