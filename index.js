const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  ChannelType,
  REST,
  Routes,
} = require('discord.js');
const { RiotAPI } = require('./riot');
const { Storage } = require('./storage');
const { buildGameEmbed, buildInGameEmbed, buildProfileEmbed, getPerformanceRank } = require('./embeds');
require('dotenv').config();

// ─── Init ─────────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MINUTES || '3') * 60 * 1000;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const storage = new Storage('./data.json');
const riot = new RiotAPI(process.env.RIOT_API_KEY);

// Track les parties déjà notifiées (clé = "playerKey:gameId") pour éviter les doublons
const inGameNotified = new Set();

// ─── Slash Commands definitions ───────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName('register')
    .setDescription('Enregistre un joueur LoL à suivre automatiquement')
    .addStringOption(o =>
      o.setName('summoner')
        .setDescription('Pseudo Riot ID format Nom#Tag (ex: Faker#KR1)')
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName('region')
        .setDescription('Région du compte')
        .setRequired(true)
        .addChoices(
          { name: 'EUW (Europe Ouest)', value: 'euw' },
          { name: 'EUNE (Europe Nord-Est)', value: 'eune' },
          { name: 'NA (Amérique du Nord)', value: 'na' },
          { name: 'KR (Corée)', value: 'kr' },
          { name: 'BR (Brésil)', value: 'br' },
          { name: 'JP (Japon)', value: 'jp' },
          { name: 'TR (Turquie)', value: 'tr' },
          { name: 'RU (Russie)', value: 'ru' },
          { name: 'OCE (Océanie)', value: 'oce' },
        )
    ),

  new SlashCommandBuilder()
    .setName('unregister')
    .setDescription('Supprime un joueur de la liste de suivi')
    .addStringOption(o =>
      o.setName('summoner')
        .setDescription('Pseudo Riot ID (Nom#Tag ou juste Nom)')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('lastgame')
    .setDescription('Affiche les stats de la dernière partie d\'un joueur')
    .addStringOption(o =>
      o.setName('summoner')
        .setDescription('Nom#Tag (optionnel — prend le premier joueur sinon)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('list')
    .setDescription('Liste tous les joueurs enregistrés et leur rank actuel'),

  new SlashCommandBuilder()
    .setName('setchannel')
    .setDescription('Définit le salon où le bot postera les résultats automatiquement')
    .addChannelOption(o =>
      o.setName('channel')
        .setDescription('Salon Discord (doit être un salon texte)')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('check')
    .setDescription('Force la vérification immédiate des nouvelles parties'),

  new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Affiche le profil ranked complet d\'un joueur')
    .addStringOption(o =>
      o.setName('summoner')
        .setDescription('Nom#Tag (optionnel -- prend le premier joueur sinon)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('live')
    .setDescription('Affiche la partie en cours d\'un joueur avec tous les participants')
    .addStringOption(o =>
      o.setName('summoner')
        .setDescription('Nom#Tag (optionnel — prend le premier joueur sinon)')
        .setRequired(false)
    ),
];

// ─── Register slash commands ──────────────────────────────────────────────────

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    // Purge les commandes globales (évite les doublons global + guilde)
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [] });

    // Enregistre par guilde (instantané) au lieu de globalement
    const guilds = client.guilds.cache;
    for (const [guildId] of guilds) {
      await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId), {
        body: commands.map(c => c.toJSON()),
      });
      console.log(`Slash commands enregistrées sur le serveur ${guildId}`);
    }
  } catch (err) {
    console.error('Erreur enregistrement commands:', err.message);
  }
}

// ─── Core: Fetch summoner info from scratch ───────────────────────────────────

async function fetchAndStoreSummoner(gameName, tagLine, regionShort) {
  const platform = riot.getPlatform(regionShort);
  const regional = riot.getRegional(platform);

  // 1) Récupère le PUUID via Riot ID
  const account = await riot.getAccountByRiotId(gameName, tagLine, regional);

  // 2) Ranked entries (directement par PUUID)
  const entries = await riot.getLeagueEntries(account.puuid, platform);
  const entry = riot.getRankedEntry(entries);

  // 4) Dernière partie pour initialiser le lastMatchId
  const matchIds = await riot.getRecentMatchIds(account.puuid, regional, 1);

  return {
    gameName: account.gameName,
    tagLine: account.tagLine,
    puuid: account.puuid,
    platform,
    regional,
    lastMatchId: matchIds[0] || null,
    currentLP: entry?.leaguePoints ?? null,
    currentTier: entry?.tier ?? null,
    currentRank: entry?.rank ?? null,
    currentQueueType: entry?.queueType ?? null,
  };
}

// ─── Core: Get last game stats ────────────────────────────────────────────────

/**
 * @param {Object} playerData  - Données stockées du joueur
 * @param {boolean} onlyNew    - Si true, retourne null si pas de nouvelle partie
 * @returns {{ embed, updatedPlayer } | null}
 */
async function getLastGameStats(playerData, onlyNew = false) {
  // Fetch la dernière partie (toutes queues)
  const matchIds = await riot.getRecentMatchIds(playerData.puuid, playerData.regional, 1);
  const latestMatchId = matchIds[0];

  if (!latestMatchId) return null;
  if (onlyNew && latestMatchId === playerData.lastMatchId) return null;

  // Fetch les détails de la partie
  const match = await riot.getMatch(latestMatchId, playerData.regional);
  const participant = match.info.participants.find(p => p.puuid === playerData.puuid);
  if (!participant) return null;

  // Fetch le ranked actuel APRÈS la partie (le LP a déjà changé)
  const entries = await riot.getLeagueEntries(playerData.puuid, playerData.platform);
  const entry = riot.getRankedEntry(entries);

  // Calcul du gain/perte de LP
  // Uniquement pour Ranked Solo/Duo (queue 420) si on avait un LP stocké
  let lpChange = null;
  const isRankedSolo = match.info.queueId === 420;

  if (isRankedSolo && entry && playerData.currentLP !== null) {
    const tierChanged = entry.tier !== playerData.currentTier;

    if (!tierChanged) {
      lpChange = entry.leaguePoints - playerData.currentLP;
      // Sécurité: ignore les valeurs aberrantes (ex: -90 = probablement changement de tier)
      if (Math.abs(lpChange) > 70) lpChange = null;
    }
  }

  // Classement du joueur dans la partie (1–10)
  const perfRank = getPerformanceRank(participant, match.info.participants);

  // Image du champion
  const championUrl = await riot.getChampionImageUrl(participant.championName);

  // Construit l'embed
  const embed = buildGameEmbed({
    player: playerData,
    match,
    participant,
    entry,
    lpChange,
    perfRank,
    championUrl,
  });

  // Données mises à jour à sauvegarder
  const updatedPlayer = {
    ...playerData,
    lastMatchId: latestMatchId,
    currentLP: entry?.leaguePoints ?? playerData.currentLP,
    currentTier: entry?.tier ?? playerData.currentTier,
    currentRank: entry?.rank ?? playerData.currentRank,
    currentQueueType: entry?.queueType ?? playerData.currentQueueType,
  };

  return { embed, updatedPlayer };
}

// ─── Polling ──────────────────────────────────────────────────────────────────

// ─── Live Game Detection ──────────────────────────────────────────────────────

const QUEUE_TYPES = {
  420: 'Ranked Solo/Duo',
  440: 'Ranked Flex',
  400: 'Normal Draft',
  430: 'Normal Blind',
  450: 'ARAM',
  900: 'URF',
  1900: 'URF',
  1020: 'One for All',
};

async function pollLiveGames() {
  const config = storage.getConfig();
  const channelId = config.channelId;
  if (!channelId) return;

  const channel = client.channels.cache.get(channelId);
  if (!channel) return;

  const players = storage.getPlayers();
  const playerList = Object.entries(players);

  for (const [key, playerData] of playerList) {
    try {
      const activeGame = await riot.getActiveGame(playerData.puuid, playerData.platform);

      if (activeGame) {
        const gameId = String(activeGame.gameId);
        // Vérifie si on a déjà notifié cette partie (persisté dans storage)
        if (playerData.lastNotifiedGameId !== gameId) {
          const participant = activeGame.participants.find(p => p.puuid === playerData.puuid);
          const champId = participant?.championId;
          const championName = await getChampionNameById(champId);
          const championTechId = await getChampionIdById(champId);
          const queueName = QUEUE_TYPES[activeGame.gameQueueConfigId] || 'Partie personnalisée';
          const championUrl = await riot.getChampionImageUrl(championTechId);

          const embed = buildInGameEmbed({
            player: playerData,
            championName,
            championUrl,
            queueName,
          });

          await channel.send({ embeds: [embed] });
          // Persiste le gameId pour éviter les doublons même après redémarrage
          storage.setPlayer(key, { ...playerData, lastNotifiedGameId: gameId });
          console.log(`[${new Date().toLocaleTimeString()}] En game : ${playerData.gameName}#${playerData.tagLine} (game ${gameId})`);
        }
      }

      if (playerList.length > 1) {
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch (err) {
      console.error(`Erreur live game [${key}]:`, err.message);
    }
  }
}

// Cache champion ID -> { id, name }
let _championMap = null;
async function _loadChampionMap() {
  if (_championMap) return;
  const v = await riot.getDDragonVersion();
  const res = await require('node-fetch')(`https://ddragon.leagueoflegends.com/cdn/${v}/data/en_US/champion.json`);
  const data = await res.json();
  _championMap = {};
  for (const champ of Object.values(data.data)) {
    _championMap[parseInt(champ.key)] = { id: champ.id, name: champ.name };
  }
}

// Retourne le nom d'affichage (ex: "Miss Fortune")
async function getChampionNameById(championId) {
  await _loadChampionMap();
  return _championMap[championId]?.name || 'Unknown';
}

// Retourne l'ID technique (ex: "MissFortune") pour les URLs d'image
async function getChampionIdById(championId) {
  await _loadChampionMap();
  return _championMap[championId]?.id || 'Unknown';
}

// Cache champion name -> all roles (from Meraki), triés par priorité
let _championRoles = null;
async function getChampionRoles() {
  if (_championRoles) return _championRoles;
  try {
    const res = await require('node-fetch')('https://cdn.merakianalytics.com/riot/lol/resources/latest/en-US/champions.json');
    const data = await res.json();
    _championRoles = {};
    for (const [name, champ] of Object.entries(data)) {
      if (champ.positions && champ.positions.length > 0) {
        _championRoles[name] = champ.positions; // Tous les rôles possibles
      }
    }
  } catch {
    _championRoles = {};
  }
  return _championRoles;
}

const MERAKI_TO_ROLE = {
  TOP: 'Top',
  JUNGLE: 'Jungle',
  MIDDLE: 'Mid',
  BOTTOM: 'ADC',
  SUPPORT: 'Support',
};

// ─── Polling ──────────────────────────────────────────────────────────────────

async function pollAllPlayers() {
  const config = storage.getConfig();
  const channelId = config.channelId;
  if (!channelId) return;

  const channel = client.channels.cache.get(channelId);
  if (!channel) return;

  const players = storage.getPlayers();
  const playerList = Object.entries(players);

  for (const [key, playerData] of playerList) {
    try {
      const result = await getLastGameStats(playerData, true);
      if (!result) continue;

      const { embed, updatedPlayer } = result;
      storage.setPlayer(key, updatedPlayer);
      await channel.send({ embeds: [embed] });
      console.log(`📊 [${new Date().toLocaleTimeString()}] Nouvelle partie postée : ${playerData.gameName}#${playerData.tagLine}`);

      // Rate limit safety entre chaque joueur
      if (playerList.length > 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (err) {
      console.error(`❌ Polling erreur pour [${key}]:`, err.message);
    }
  }
}

// ─── Interaction handler ──────────────────────────────────────────────────────

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    await interaction.deferReply();
  } catch (e) {
    console.error(`[deferReply échoué] /${interaction.commandName}: ${e.message}`);
    return;
  }

  const { commandName } = interaction;

  try {
    // ── /register ──────────────────────────────────────────────────────────────
    if (commandName === 'register') {
      const input = interaction.options.getString('summoner');
      const regionShort = interaction.options.getString('region');

      if (!input.includes('#')) {
        return interaction.editReply('Format invalide. Utilise `Pseudo#Tag` (ex: `Faker#KR1`)');
      }

      const [gameName, tagLine] = input.split('#');
      const key = `${gameName}#${tagLine}`.toLowerCase();

      if (storage.getPlayer(key)) {
        return interaction.editReply(`**${gameName}#${tagLine}** est déjà dans la liste.`);
      }

      await interaction.editReply(`Récupération des données de **${gameName}#${tagLine}**...`);

      const info = await fetchAndStoreSummoner(gameName, tagLine, regionShort);
      storage.setPlayer(key, info);

      const rankStr = info.currentTier
        ? `${info.currentTier} ${info.currentRank} — ${info.currentLP} LP`
        : 'Non classé';

      return interaction.editReply(
        `**${info.gameName}#${info.tagLine}** enregistré sur **${regionShort.toUpperCase()}**\n` +
        `Rank actuel : ${rankStr}\n` +
        `Référence partie initialisée — les prochaines parties seront détectées automatiquement.`
      );
    }

    // ── /unregister ────────────────────────────────────────────────────────────
    if (commandName === 'unregister') {
      const input = interaction.options.getString('summoner');
      const player = storage.findPlayer(input);

      if (!player) {
        return interaction.editReply(`Joueur **${input}** non trouvé.`);
      }

      const key = `${player.gameName}#${player.tagLine}`.toLowerCase();
      storage.removePlayer(key);
      return interaction.editReply(`**${player.gameName}#${player.tagLine}** supprimé de la liste de suivi.`);
    }

    // ── /lastgame ──────────────────────────────────────────────────────────────
    if (commandName === 'lastgame') {
      const input = interaction.options.getString('summoner');
      const players = storage.getPlayers();

      let playerData;

      if (input) {
        playerData = storage.findPlayer(input);
        if (!playerData) {
          return interaction.editReply(
            `**${input}** non enregistré. Utilise \`/register\` d'abord.`
          );
        }
      } else {
        const keys = Object.keys(players);
        if (!keys.length) {
          return interaction.editReply('Aucun joueur enregistré. Utilise `/register`.');
        }
        playerData = players[keys[0]];
      }

      const result = await getLastGameStats(playerData, false);
      if (!result) {
        return interaction.editReply('Aucune partie trouvée pour ce joueur.');
      }

      const { embed, updatedPlayer } = result;
      const key = `${playerData.gameName}#${playerData.tagLine}`.toLowerCase();
      storage.setPlayer(key, updatedPlayer);
      return interaction.editReply({ content: '', embeds: [embed] });
    }

    // ── /list ──────────────────────────────────────────────────────────────────
    if (commandName === 'list') {
      const players = storage.getPlayers();
      const keys = Object.keys(players);

      if (!keys.length) {
        return interaction.editReply('Aucun joueur enregistré. Utilise `/register`.');
      }

      const lines = keys.map((k, i) => {
        const p = players[k];
        const rank = p.currentTier
          ? `${p.currentTier} ${p.currentRank} — ${p.currentLP} LP`
          : 'Non classé';
        return `\`${i + 1}.\` **${p.gameName}#${p.tagLine}** (${p.platform.toUpperCase()}) — ${rank}`;
      });

      return interaction.editReply(
        `**Joueurs suivis (${keys.length}) :**\n${lines.join('\n')}`
      );
    }

    // ── /setchannel ────────────────────────────────────────────────────────────
    if (commandName === 'setchannel') {
      const channel = interaction.options.getChannel('channel');
      storage.setConfig('channelId', channel.id);
      return interaction.editReply(
        `Salon de notifications défini : ${channel}\n` +
        `Le bot postera automatiquement les résultats ici toutes les **${POLL_INTERVAL_MS / 60000} minutes**.`
      );
    }

    // ── /check ─────────────────────────────────────────────────────────────────
    if (commandName === 'check') {
      const players = storage.getPlayers();
      if (!Object.keys(players).length) {
        return interaction.editReply('Aucun joueur enregistré.');
      }
      await interaction.editReply('Vérification des nouvelles parties en cours...');
      await pollAllPlayers();
      return interaction.editReply('Vérification terminée. Les nouvelles parties ont été postées (si le salon est configuré).');
    }

    // ── /profile ───────────────────────────────────────────────────────────
    if (commandName === 'profile') {
      const input = interaction.options.getString('summoner');
      const players = storage.getPlayers();

      let playerData;
      if (input) {
        playerData = storage.findPlayer(input);
        if (!playerData) {
          return interaction.editReply(`**${input}** non enregistre. Utilise \`/register\` d'abord.`);
        }
      } else {
        const keys = Object.keys(players);
        if (!keys.length) {
          return interaction.editReply('Aucun joueur enregistre. Utilise `/register`.');
        }
        playerData = players[keys[0]];
      }

      // Fetch summoner data for profile icon
      const summoner = await riot.getSummonerByPuuid(playerData.puuid, playerData.platform);
      const profileIconUrl = await riot.getProfileIconUrl(summoner.profileIconId);

      // Fetch ranked entries
      const entries = await riot.getLeagueEntries(playerData.puuid, playerData.platform);
      const entry = riot.getRankedEntry(entries);

      // Update peak rank
      let peakTier = playerData.peakTier || null;
      let peakRank = playerData.peakRank || null;
      let peakLP = playerData.peakLP || null;

      if (entry && entry.tier) {
        if (!peakTier || riot.compareRank(entry.tier, entry.rank, entry.leaguePoints, peakTier, peakRank, peakLP) > 0) {
          peakTier = entry.tier;
          peakRank = entry.rank;
          peakLP = entry.leaguePoints;
        }
      }

      // Fetch recent ranked matches (20)
      const matchCount = 20;
      const matchIds = await riot.getRecentMatchIds(playerData.puuid, playerData.regional, matchCount, 420);

      // Aggregate champion stats
      const champMap = {};
      for (let i = 0; i < matchIds.length; i++) {
        try {
          const match = await riot.getMatch(matchIds[i], playerData.regional);
          const p = match.info.participants.find(x => x.puuid === playerData.puuid);
          if (!p) continue;

          const name = p.championName;
          if (!champMap[name]) {
            champMap[name] = { championName: name, games: 0, wins: 0, kills: 0, deaths: 0, assists: 0, cs: 0, duration: 0 };
          }
          const c = champMap[name];
          c.games++;
          if (p.win) c.wins++;
          c.kills += p.kills;
          c.deaths += p.deaths;
          c.assists += p.assists;
          c.cs += (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0);
          c.duration += match.info.gameDuration;

          // Rate limit between fetches
          if (i < matchIds.length - 1) {
            await new Promise(r => setTimeout(r, 300));
          }
        } catch (err) {
          console.error(`Erreur fetch match ${matchIds[i]}:`, err.message);
        }
      }

      const championStats = Object.values(champMap)
        .sort((a, b) => b.games - a.games)
        .slice(0, 5);

      // Rank emblem URL
      const emblemUrl = entry ? riot.getRankEmblemUrl(entry.tier) : null;

      // Save peak
      const key = `${playerData.gameName}#${playerData.tagLine}`.toLowerCase();
      storage.setPlayer(key, { ...playerData, peakTier, peakRank, peakLP });

      const embed = buildProfileEmbed({
        player: playerData,
        entry,
        peakTier,
        peakRank,
        peakLP,
        championStats,
        totalGames: matchIds.length,
        emblemUrl,
        profileIconUrl,
      });

      return interaction.editReply({ content: '', embeds: [embed] });
    }

    // ── /live ──────────────────────────────────────────────────────────────────
    if (commandName === 'live') {
      const input = interaction.options.getString('summoner');
      const players = storage.getPlayers();

      let playerData;
      if (input) {
        playerData = storage.findPlayer(input);
        if (!playerData) {
          return interaction.editReply(`**${input}** non enregistré. Utilise \`/register\` d'abord.`);
        }
      } else {
        const keys = Object.keys(players);
        if (!keys.length) {
          return interaction.editReply('Aucun joueur enregistré. Utilise `/register`.');
        }
        playerData = players[keys[0]];
      }

      console.log(`[/live] Recherche partie pour ${playerData.gameName}...`);
      const activeGame = await riot.getActiveGame(playerData.puuid, playerData.platform);
      if (!activeGame) {
        return interaction.editReply(`**${playerData.gameName}** n'est pas en partie actuellement.`);
      }
      console.log(`[/live] Partie trouvée, ${activeGame.participants.length} participants`);

      const queueName = QUEUE_TYPES[activeGame.gameQueueConfigId] || 'Partie personnalisée';
      const gameDuration = Math.floor((Date.now() - activeGame.gameStartTime) / 1000);
      const durationMin = Math.floor(gameDuration / 60);
      const durationSec = gameDuration % 60;

      const championRoles = await getChampionRoles();
      const SPELL_SMITE = 11;
      const ROLE_ORDER = { Top: 0, Jungle: 1, Mid: 2, ADC: 3, Support: 4 };

      // Assigne les rôles de façon exclusive (chaque rôle ne peut être pris qu'une fois)
      function assignRoles(teamParticipants) {
        const roles = new Array(teamParticipants.length).fill(null);
        const takenRoles = new Set();
        const assigned = new Set();

        // 1) Smite → Jungle
        teamParticipants.forEach((p, i) => {
          if (p.spell1Id === SPELL_SMITE || p.spell2Id === SPELL_SMITE) {
            roles[i] = 'Jungle';
            takenRoles.add('Jungle');
            assigned.add(i);
          }
        });

        // 2) Prépare les candidats avec tous leurs rôles Meraki possibles
        const candidates = teamParticipants.map((p, i) => {
          if (assigned.has(i)) return null;
          const champId = _championMap[p.championId]?.id;
          const allRoles = champId && championRoles[champId]
            ? (Array.isArray(championRoles[champId]) ? championRoles[champId] : [championRoles[champId]])
            : [];
          return { index: i, roles: allRoles.map(r => MERAKI_TO_ROLE[r] || 'Mid') };
        }).filter(Boolean);

        // 3) Assigne d'abord les champions qui n'ont qu'un seul rôle possible
        candidates.sort((a, b) => a.roles.length - b.roles.length);
        for (const c of candidates) {
          const available = c.roles.find(r => !takenRoles.has(r));
          if (available) {
            roles[c.index] = available;
            takenRoles.add(available);
            assigned.add(c.index);
          }
        }

        // 4) Restants → premier rôle libre
        const allRoles = ['Top', 'Jungle', 'Mid', 'ADC', 'Support'];
        teamParticipants.forEach((p, i) => {
          if (!assigned.has(i)) {
            const freeRole = allRoles.find(r => !takenRoles.has(r)) || 'Mid';
            roles[i] = freeRole;
            takenRoles.add(freeRole);
          }
        });

        return roles;
      }

      const team1P = activeGame.participants.filter(p => p.teamId === 100);
      const team2P = activeGame.participants.filter(p => p.teamId === 200);
      const team1Roles = assignRoles(team1P);
      const team2Roles = assignRoles(team2P);

      // Construit les données de base (instantané)
      const buildParticipant = (p, role) => {
        const champData = _championMap[p.championId];
        let displayName;
        if (p.riotId && p.riotId.trim() !== '') displayName = p.riotId;
        else if (p.summonerName && p.summonerName.trim() !== '') displayName = p.summonerName;
        else displayName = 'Streamer';
        return {
          teamId: p.teamId,
          championName: champData?.name || 'Unknown',
          displayName,
          role,
          roleOrder: ROLE_ORDER[role] ?? 9,
          isTarget: p.puuid === playerData.puuid,
          puuid: p.puuid,
          rankStr: '...',
        };
      };

      const allData = [
        ...team1P.map((p, i) => buildParticipant(p, team1Roles[i])),
        ...team2P.map((p, i) => buildParticipant(p, team2Roles[i])),
      ];

      const formatTeam = (teamData) =>
        teamData.sort((a, b) => a.roleOrder - b.roleOrder).map(p => {
          const name = p.isTarget ? `**${p.displayName}**` : p.displayName;
          return `\`${p.role.padEnd(7)}\` ${p.championName} - ${name} (${p.rankStr})`;
        }).join('\n');

      const { EmbedBuilder } = require('discord.js');
      const buildEmbed = () => new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle(`${queueName} - ${durationMin}m ${String(durationSec).padStart(2, '0')}s`)
        .addFields(
          { name: 'Equipe Bleue', value: formatTeam(allData.filter(p => p.teamId === 100)), inline: false },
          { name: 'Equipe Rouge', value: formatTeam(allData.filter(p => p.teamId === 200)), inline: false },
        )
        .setFooter({ text: `Partie de ${playerData.gameName}#${playerData.tagLine}` });

      // Envoie d'abord sans les ranks
      await interaction.editReply({ content: '', embeds: [buildEmbed()] });
      console.log(`[/live] Embed envoyé, chargement des ranks...`);

      // Puis charge les ranks en arrière-plan et update le message
      await Promise.all(allData.map(async (pData) => {
        try {
          const entries = await riot.getLeagueEntries(pData.puuid, playerData.platform);
          const entry = riot.getRankedEntry(entries);
          pData.rankStr = entry ? `${entry.tier} ${entry.rank} - ${entry.leaguePoints} LP` : 'Unranked';
        } catch {
          pData.rankStr = 'N/A';
        }
      }));

      // Met à jour le message avec les ranks
      await interaction.editReply({ content: '', embeds: [buildEmbed()] }).catch(() => {});
      console.log(`[/live] Ranks chargés et mis à jour`);
      return;
    }

  } catch (err) {
    console.error(`❌ Commande /${commandName} :`, err.message);
    return interaction.editReply(`Erreur : ${err.message}`);
  }
});

// ─── Bot Ready ────────────────────────────────────────────────────────────────

client.once('ready', async () => {
  console.log(`\n🤖 Bot connecté : ${client.user.tag}`);
  console.log(`📡 Serveurs : ${client.guilds.cache.size}`);

  await registerCommands();

  // Pré-cache les données au démarrage
  const v = await riot.getDDragonVersion();
  console.log(`DDragon version : ${v}`);
  await _loadChampionMap();
  await getChampionRoles();
  console.log('Caches champions et rôles chargés.');

  // Démarrage du polling
  setInterval(pollAllPlayers, POLL_INTERVAL_MS);
  setInterval(pollLiveGames, POLL_INTERVAL_MS); // Même intervalle que les résultats
  console.log(`Polling: résultats et live games toutes les ${POLL_INTERVAL_MS / 60000} min.\n`);
});

// ─── Error handling ───────────────────────────────────────────────────────────

client.on('error', err => console.error('❌ Discord client error:', err));
process.on('unhandledRejection', err => console.error('❌ Unhandled rejection:', err));

// ─── Login ────────────────────────────────────────────────────────────────────

client.login(process.env.DISCORD_TOKEN);
