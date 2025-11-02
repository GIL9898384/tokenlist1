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

const fakeNames = ['mkzinho 😇', 'Maria 💖', 'João 🎮', 'Ana 🌟', 'Pedro 🔥', 'Julia 💎', 'Lucas 😎', 'Camila 🌸', 'Rafael 🚀', 'Beatriz 💕', 'Gabriel 🎵', 'Larissa 🦋', 'Felipe 💪', 'Amanda 🌺', 'Thiago 🎯', 'Isabela 👑', 'Diego 🏆', 'Fernanda 🌙', 'Bruno 🎸', 'Leticia 💋', 'Rodrigo ⚡', 'Gabriela 🌹', 'Vinicius 🎭', 'Carolina 🍀', 'Leonardo 🌊', 'Patricia 💫'];

const fakeTitles = ['os melhores do ano 😇', 'Conversando com vocês! 💬', 'Bate-papo ao vivo 🎙️', 'Interação com os seguidores ✨', 'Respondendo perguntas 💭', 'Live tranquila 🌿', 'Jogando com os amigos 🎮', 'Cantando suas músicas 🎤', 'Mostrando meu dia 📸', 'Fazendo tutorial 📚', 'Desafios e brincadeiras 🎲', 'Conhecendo vocês melhor 💕', 'Compartilhando dicas 💡', 'Sessão de perguntas ❓', 'Hora do café ☕', 'Papo descontraído 😄', 'Contando histórias 📖', 'Novidades e updates 🆕', 'Agradecendo o carinho 🙏', 'Live especial 🎁', 'Curtindo com vocês 🎉', 'Música ao vivo 🎵', 'Divulgando projetos 🎬', 'Relaxando juntos 🌅', 'Festa virtual 🎊', 'Encontro com fãs 💖'];

fakeCovers.forEach((cover, index) => {
  // mkzinho tem foto de perfil específica
  const profilePic = index === 0 
    ? 'https://fake-api-backend-no5q.onrender.com/api/profile-pic/1756687168474'
    : `https://randomuser.me/api/portraits/${index % 2 === 0 ? 'women' : 'men'}/${(index % 50) + 1}.jpg`;
  
  livesBase.push({
    id: `fake_${1756687168364 + index}`,
    streamerId: index === 0 ? '1756687168474' : `fake_${1756687168364 + index}`,
    name: fakeNames[index],
    imageUrl: profilePic,
    agoraChannel: `canal_fake_${index}`,
    streamerUid: 123456 + index,
    title: fakeTitles[index],
    coverImageUrl: cover,
    lastHeartbeat: Math.floor(Date.now() / 1000)
  });
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
