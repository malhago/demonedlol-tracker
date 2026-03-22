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
const { buildGameEmbed, buildInGameEmbed, getPerformanceRank } = require('./embeds');
require('dotenv').config();

// ─── Init ─────────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MINUTES || '3') * 60 * 1000;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const storage = new Storage('./data.json');
const riot = new RiotAPI(process.env.RIOT_API_KEY);

// Track les joueurs déjà notifiés comme "en game" pour éviter les doublons
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
];

// ─── Register slash commands ──────────────────────────────────────────────────

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('📡 Enregistrement des slash commands...');
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
      body: commands.map(c => c.toJSON()),
    });
    console.log('✅ Slash commands enregistrées globalement.');
  } catch (err) {
    console.error('❌ Erreur enregistrement commands:', err.message);
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
        if (!inGameNotified.has(key)) {
          const participant = activeGame.participants.find(p => p.puuid === playerData.puuid);
          const championId = participant?.championId;
          const championName = await getChampionNameById(championId);
          const queueName = QUEUE_TYPES[activeGame.gameQueueConfigId] || 'Partie personnalisée';
          const championUrl = await riot.getChampionImageUrl(championName);

          const embed = buildInGameEmbed({
            player: playerData,
            championName,
            championUrl,
            queueName,
          });

          await channel.send({ embeds: [embed] });
          inGameNotified.add(key);
          console.log(`[${new Date().toLocaleTimeString()}] En game : ${playerData.gameName}#${playerData.tagLine}`);
        }
      } else {
        inGameNotified.delete(key);
      }

      if (playerList.length > 1) {
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch (err) {
      console.error(`Erreur live game [${key}]:`, err.message);
    }
  }
}

// Cache champion ID -> name
let _championMap = null;
async function getChampionNameById(championId) {
  if (!_championMap) {
    const v = await riot.getDDragonVersion();
    const res = await require('node-fetch')(`https://ddragon.leagueoflegends.com/cdn/${v}/data/en_US/champion.json`);
    const data = await res.json();
    _championMap = {};
    for (const champ of Object.values(data.data)) {
      _championMap[parseInt(champ.key)] = champ.id;
    }
  }
  return _championMap[championId] || 'Unknown';
}

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

  await interaction.deferReply();

  const { commandName } = interaction;

  try {
    // ── /register ──────────────────────────────────────────────────────────────
    if (commandName === 'register') {
      const input = interaction.options.getString('summoner');
      const regionShort = interaction.options.getString('region');

      if (!input.includes('#')) {
        return interaction.editReply('❌ Format invalide. Utilise `Pseudo#Tag` (ex: `Faker#KR1`)');
      }

      const [gameName, tagLine] = input.split('#');
      const key = `${gameName}#${tagLine}`.toLowerCase();

      if (storage.getPlayer(key)) {
        return interaction.editReply(`⚠️ **${gameName}#${tagLine}** est déjà dans la liste.`);
      }

      await interaction.editReply(`🔄 Récupération des données de **${gameName}#${tagLine}**...`);

      const info = await fetchAndStoreSummoner(gameName, tagLine, regionShort);
      storage.setPlayer(key, info);

      const rankStr = info.currentTier
        ? `${info.currentTier} ${info.currentRank} — ${info.currentLP} LP`
        : 'Non classé';

      return interaction.editReply(
        `✅ **${info.gameName}#${info.tagLine}** enregistré sur **${regionShort.toUpperCase()}**\n` +
        `🏆 Rank actuel : ${rankStr}\n` +
        `📌 Référence partie initialisée — les prochaines parties seront détectées automatiquement.`
      );
    }

    // ── /unregister ────────────────────────────────────────────────────────────
    if (commandName === 'unregister') {
      const input = interaction.options.getString('summoner');
      const player = storage.findPlayer(input);

      if (!player) {
        return interaction.editReply(`❌ Joueur **${input}** non trouvé.`);
      }

      const key = `${player.gameName}#${player.tagLine}`.toLowerCase();
      storage.removePlayer(key);
      return interaction.editReply(`🗑️ **${player.gameName}#${player.tagLine}** supprimé de la liste de suivi.`);
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
            `❌ **${input}** non enregistré. Utilise \`/register\` d'abord.`
          );
        }
      } else {
        const keys = Object.keys(players);
        if (!keys.length) {
          return interaction.editReply('❌ Aucun joueur enregistré. Utilise `/register`.');
        }
        playerData = players[keys[0]];
      }

      const result = await getLastGameStats(playerData, false);
      if (!result) {
        return interaction.editReply('❌ Aucune partie trouvée pour ce joueur.');
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
        return interaction.editReply('📋 Aucun joueur enregistré. Utilise `/register`.');
      }

      const lines = keys.map((k, i) => {
        const p = players[k];
        const rank = p.currentTier
          ? `${p.currentTier} ${p.currentRank} — ${p.currentLP} LP`
          : 'Non classé';
        return `\`${i + 1}.\` **${p.gameName}#${p.tagLine}** (${p.platform.toUpperCase()}) — ${rank}`;
      });

      return interaction.editReply(
        `📋 **Joueurs suivis (${keys.length}) :**\n${lines.join('\n')}`
      );
    }

    // ── /setchannel ────────────────────────────────────────────────────────────
    if (commandName === 'setchannel') {
      const channel = interaction.options.getChannel('channel');
      storage.setConfig('channelId', channel.id);
      return interaction.editReply(
        `✅ Salon de notifications défini : ${channel}\n` +
        `📡 Le bot postera automatiquement les résultats ici toutes les **${POLL_INTERVAL_MS / 60000} minutes**.`
      );
    }

    // ── /check ─────────────────────────────────────────────────────────────────
    if (commandName === 'check') {
      const players = storage.getPlayers();
      if (!Object.keys(players).length) {
        return interaction.editReply('❌ Aucun joueur enregistré.');
      }
      await interaction.editReply('🔄 Vérification des nouvelles parties en cours...');
      await pollAllPlayers();
      return interaction.editReply('✅ Vérification terminée. Les nouvelles parties ont été postées (si le salon est configuré).');
    }

  } catch (err) {
    console.error(`❌ Commande /${commandName} :`, err.message);
    return interaction.editReply(`❌ Erreur : ${err.message}`);
  }
});

// ─── Bot Ready ────────────────────────────────────────────────────────────────

client.once('ready', async () => {
  console.log(`\n🤖 Bot connecté : ${client.user.tag}`);
  console.log(`📡 Serveurs : ${client.guilds.cache.size}`);

  await registerCommands();

  // Pré-cache la version DDragon
  riot.getDDragonVersion().then(v => console.log(`🐉 DDragon version : ${v}`));

  // Démarrage du polling
  setInterval(pollAllPlayers, POLL_INTERVAL_MS);
  setInterval(pollLiveGames, 60 * 1000); // Vérifie les parties en cours toutes les 60s
  console.log(`Polling: résultats toutes les ${POLL_INTERVAL_MS / 60000} min, live games toutes les 60s.\n`);
});

// ─── Error handling ───────────────────────────────────────────────────────────

client.on('error', err => console.error('❌ Discord client error:', err));
process.on('unhandledRejection', err => console.error('❌ Unhandled rejection:', err));

// ─── Login ────────────────────────────────────────────────────────────────────

client.login(process.env.DISCORD_TOKEN);
