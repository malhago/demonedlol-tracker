const { EmbedBuilder } = require('discord.js');

// ─── Constants ────────────────────────────────────────────────────────────────

const TIER_EMOJIS = {
  IRON: '<:iron:0>',
  BRONZE: '🥉',
  SILVER: '🥈',
  GOLD: '🥇',
  PLATINUM: '💠',
  EMERALD: '💚',
  DIAMOND: '💎',
  MASTER: '🔮',
  GRANDMASTER: '🏆',
  CHALLENGER: '👑',
};

const QUEUE_NAMES = {
  420: 'Ranked Solo/Duo',
  440: 'Ranked Flex',
  400: 'Normal Draft',
  430: 'Normal Blind',
  450: 'ARAM',
  900: 'URF',
  1900: 'URF',
  1020: 'One for All',
  720: 'ARAM Clash',
  830: 'Co-op vs IA',
};

const POSITION_LABELS = {
  TOP: 'Top',
  JUNGLE: 'Jungle',
  MIDDLE: 'Mid',
  BOTTOM: 'ADC',
  UTILITY: 'Support',
  NONE: '',
};

// ─── Performance rank (1–10) ──────────────────────────────────────────────────

/**
 * Calcule le classement d'un participant parmi les 10 joueurs.
 * Formule : score composite = KDA pondéré + damage/1000 + vision + participation
 */
function getPerformanceRank(participant, allParticipants) {
  const score = (p) => {
    const kda =
      p.deaths === 0
        ? (p.kills + p.assists) * 1.5
        : (p.kills + p.assists) / p.deaths;

    const damageScore = (p.totalDamageDealtToChampions || 0) / 2000;
    const visionScore = (p.visionScore || 0) / 10;
    const killParticipation = p.challenges?.killParticipation || 0;

    return kda * 2 + damageScore + visionScore + killParticipation * 3;
  };

  const sorted = [...allParticipants].sort((a, b) => score(b) - score(a));
  return sorted.findIndex(p => p.puuid === participant.puuid) + 1;
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatKDA(kills, deaths, assists) {
  const ratio =
    deaths === 0
      ? '∞'
      : ((kills + assists) / deaths).toFixed(2);
  return `**${kills}**/${deaths}/**${assists}** (${ratio} KDA)`;
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function formatDate(timestamp) {
  const d = new Date(timestamp);
  return d.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatRank(entry) {
  if (!entry) return 'Non classé';
  return `${entry.tier} ${entry.rank} — ${entry.leaguePoints} LP`;
}

function formatLPChange(entry, lpChange, tierChanged, prevTier, prevRank) {
  const base = formatRank(entry);
  if (tierChanged && prevTier) {
    const direction =
      entry.tier > prevTier ? '**PROMOTION**' : 'Rétrogradation';
    return `${base}\n${direction} depuis ${prevTier} ${prevRank}`;
  }
  if (lpChange !== null && entry?.queueType !== undefined) {
    const sign = lpChange >= 0 ? '+' : '';
    return `${base}\n**${sign}${lpChange} LP**`;
  }
  return base;
}

function formatPerformanceRank(rank) {
  if (rank === 1) return '🏆 **MVP — #1/10**';
  if (rank === 2) return '🥈 **#2/10**';
  if (rank === 3) return '🥉 **#3/10**';
  if (rank === 10) return '💀 **Dernier — #10/10**';
  return `**#${rank}/10**`;
}

// ─── Main embed builder ───────────────────────────────────────────────────────

/**
 * @param {Object} player        - Données stockées du joueur
 * @param {Object} match         - Réponse Match v5
 * @param {Object} participant   - Participant trouvé dans match.info.participants
 * @param {Object|null} entry    - Entrée ranked actuelle
 * @param {number|null} lpChange - Variation de LP (peut être null si non ranked)
 * @param {number} perfRank      - Classement 1–10 dans la partie
 * @param {string} championUrl   - URL de l'image du champion
 */
function buildGameEmbed({ player, match, participant, entry, lpChange, perfRank, championUrl }) {
  const win = participant.win;
  const queueId = match.info.queueId;
  const queueName = QUEUE_NAMES[queueId] || `Mode ${queueId}`;
  const isRanked = queueId === 420 || queueId === 440;

  const cs =
    (participant.totalMinionsKilled || 0) +
    (participant.neutralMinionsKilled || 0);
  const csMin = (cs / (match.info.gameDuration / 60)).toFixed(1);

  const position = POSITION_LABELS[participant.teamPosition] || '';
  const gameDate = formatDate(match.info.gameEndTimestamp || match.info.gameCreation);
  const duration = formatDuration(match.info.gameDuration);

  // LP info — seulement pour les parties ranked
  let lpField = isRanked
    ? formatLPChange(
        entry,
        lpChange,
        entry && player.currentTier && entry.tier !== player.currentTier,
        player.currentTier,
        player.currentRank
      )
    : formatRank(entry);

  const multikill = buildMultikillBadge(participant);

  const embed = new EmbedBuilder()
    .setColor(win ? 0x57f287 : 0xed4245)
    .setAuthor({
      name: `${player.gameName}#${player.tagLine} — ${queueName}`,
      iconURL: championUrl,
    })
    .setTitle(
      `${win ? 'VICTOIRE' : 'DÉFAITE'}${multikill ? ` ${multikill}` : ''}`
    )
    .setThumbnail(championUrl)
    .addFields(
      {
        name: 'Champion',
        value: `${position ? position + '\n' : ''}**${participant.championName}**\nNiv. ${participant.champLevel}`,
        inline: true,
      },
      {
        name: 'KDA',
        value: formatKDA(participant.kills, participant.deaths, participant.assists),
        inline: true,
      },
      {
        name: 'Farm',
        value: `${cs} CS (**${csMin}**/min)`,
        inline: true,
      },
      {
        name: 'Dégâts champions',
        value: `${(participant.totalDamageDealtToChampions || 0).toLocaleString('fr-FR')}`,
        inline: true,
      },
      {
        name: 'Vision',
        value: `${participant.visionScore || 0} pts`,
        inline: true,
      },
      {
        name: 'Classement ranked',
        value: lpField,
        inline: false,
      }
    )
    .setFooter({ text: `${gameDate} • ${duration}` });

  return embed;
}

function buildMultikillBadge(participant) {
  if (participant.pentaKills > 0) return '**PENTA KILL!**';
  if (participant.quadraKills > 0) return '**Quadra Kill!**';
  if (participant.tripleKills > 0) return 'Triple Kill';
  return '';
}

// ─── In-Game embed ───────────────────────────────────────────────────────────

function buildInGameEmbed({ player, championName, championUrl, queueName }) {
  return new EmbedBuilder()
    .setColor(0x3498db)
    .setAuthor({
      name: `${player.gameName}#${player.tagLine}`,
      iconURL: championUrl,
    })
    .setTitle('EN PARTIE')
    .setDescription(`**${player.gameName}** est actuellement en partie avec **${championName}**`)
    .setThumbnail(championUrl)
    .addFields({
      name: 'Mode',
      value: queueName,
      inline: true,
    })
    .setFooter({ text: new Date().toLocaleTimeString('fr-FR') });
}

module.exports = { buildGameEmbed, buildInGameEmbed, getPerformanceRank };
