const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Partials } = require('discord.js');
require('dotenv').config();

const DISCORD_TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const CLIENT_ID = (process.env.CLIENT_ID || '').trim();

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}
if (!CLIENT_ID) {
  console.error('Missing CLIENT_ID in .env');
  process.exit(1);
}

const PROMOTE_ALLOWED_ROLE_ID = '1470185777010049106';
const ERLC_ALLOWED_ROLE_ID = '1470445688067326099';
const EXCLUDED_OLD_RANK_ROLE_ID = '1469454938118688955';
const SERVER_LOGO_EMOJI = '<:image_20260208_202225695:1470213220148183082>';
const SERVER_LOGO_EMOJI_URL = 'https://cdn.discordapp.com/emojis/1470213220148183082.png';
const WELCOME_CHANNEL_ID = '1470293976660709518';
const WELCOME_EMOJI = '<:image_20260208_194632977:1470204190621171762>';
const MEMBER_COUNT_EMOJI = '<:image_20260208_194406651:1470203576910348298>';
const MEMBER_COUNT_VC_ID = '1471625981960786074';
const STAFF_COUNT_VC_ID = '1471626187234349202';
const STAFF_ROLE_ID = '1469454865129279540';
const NO_PERMISSION_MSG = '<:warning:1471627951677378775> Whoops! Looks like you tried using a command without permission, watch out as doing this again will get you suspended!';
const WARNING_EMOJI = '<:warning:1471627951677378775>';
const APPEAL_CHANNEL_ID = '1471636242436194564';
const ERLC_JOIN_LOGS_CHANNEL_ID = '1469455263747670077';
const ERLC_LEAVE_LOGS_CHANNEL_ID = '1469455265307955476';
const ERLC_KICKBAN_LOGS_CHANNEL_ID = '1469455267342319616';
const ERLC_COMMAND_LOGS_CHANNEL_ID = '1469455269716168764';
const SUSPENSION_DURATION_MS = 24 * 60 * 60 * 1000;
const ERLC_LOGS_POLL_INTERVAL_MS = 30 * 1000;

const permissionDeniedCount = new Map();
const suspendedUntil = new Map();
const pendingAppeals = new Map();
const appealStore = new Map();
const processedJoinLogKeys = new Set();
const processedCommandLogKeys = new Set();

function isSuspended(userId) {
  const until = suspendedUntil.get(userId);
  if (!until) return false;
  if (Date.now() < until) return true;
  suspendedUntil.delete(userId);
  return false;
}

function recordPermissionDenied(interaction) {
  const userId = interaction.user.id;
  const count = (permissionDeniedCount.get(userId) || 0) + 1;
  permissionDeniedCount.set(userId, count);
  if (count >= 2) {
    suspendedUntil.set(userId, Date.now() + SUSPENSION_DURATION_MS);
  }
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function getProp(obj, ...keys) {
  if (obj == null) return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined) return obj[k];
  }
  return undefined;
}

async function fetchAndPostERLCLogs(discordClient, apiKey) {
  if (!apiKey) return;
  const headers = { 'Server-Key': apiKey, 'Accept': 'application/json' };
  try {
    const joinRes = await fetch('https://api.policeroleplay.community/v1/server/joinlogs', { headers });
    if (joinRes.ok) {
      const joinLogs = await joinRes.json();
      if (Array.isArray(joinLogs)) {
        const joinChannel = await discordClient.channels.fetch(ERLC_JOIN_LOGS_CHANNEL_ID).catch(() => null);
        const leaveChannel = await discordClient.channels.fetch(ERLC_LEAVE_LOGS_CHANNEL_ID).catch(() => null);
        for (const entry of joinLogs) {
          const ts = getProp(entry, 'Timestamp', 'timestamp');
          const player = getProp(entry, 'Player', 'player') || 'Unknown';
          const join = getProp(entry, 'Join', 'join');
          const key = `${ts}_${player}_${join}`;
          if (processedJoinLogKeys.has(key)) continue;
          processedJoinLogKeys.add(key);
          const playerName = String(player).split(':')[0] || player;
          const time = ts ? new Date(ts * 1000).toLocaleString() : '—';
          if (join === true && joinChannel) {
            await joinChannel.send({
              embeds: [new EmbedBuilder()
                .setTitle('Player joined')
                .addFields(
                  { name: 'Player', value: playerName, inline: true },
                  { name: 'Roblox ID', value: String(player).split(':')[1] || '—', inline: true },
                  { name: 'Time', value: time, inline: true }
                )
                .setColor(0x57F287)],
            }).catch(() => {});
          }
          if (join === false && leaveChannel) {
            await leaveChannel.send({
              embeds: [new EmbedBuilder()
                .setTitle('Player left')
                .addFields(
                  { name: 'Player', value: playerName, inline: true },
                  { name: 'Roblox ID', value: String(player).split(':')[1] || '—', inline: true },
                  { name: 'Time', value: time, inline: true }
                )
                .setColor(0xFEE75C)],
            }).catch(() => {});
          }
        }
      }
    }
  } catch (e) {
    console.error('ERLC joinlogs fetch failed:', e);
  }
  try {
    const cmdRes = await fetch('https://api.policeroleplay.community/v1/server/commandlogs', { headers });
    if (!cmdRes.ok) {
      if (cmdRes.status === 403) console.error('ERLC commandlogs: Invalid API key or unauthorized.');
      return;
    }
    const commandLogs = await cmdRes.json();
    if (!Array.isArray(commandLogs)) return;
    const kickBanChannel = await discordClient.channels.fetch(ERLC_KICKBAN_LOGS_CHANNEL_ID).catch(() => null);
    const allCommandsChannel = await discordClient.channels.fetch(ERLC_COMMAND_LOGS_CHANNEL_ID).catch(() => null);
    for (const entry of commandLogs) {
      const ts = getProp(entry, 'Timestamp', 'timestamp');
      const player = getProp(entry, 'Player', 'player') || 'Unknown';
      const command = getProp(entry, 'Command', 'command') || '';
      const key = `${ts}_${player}_${command}`;
      if (processedCommandLogKeys.has(key)) continue;
      processedCommandLogKeys.add(key);
      const playerName = String(player).split(':')[0] || player;
      const isKick = /^:kick\b/i.test(command);
      const isBan = /^:ban\b/i.test(command);
      const time = ts ? new Date(ts * 1000).toLocaleString() : '—';
      if (allCommandsChannel) {
        await allCommandsChannel.send({
          embeds: [new EmbedBuilder()
            .setTitle('Command log')
            .addFields(
              { name: 'Command used by (Roblox)', value: playerName, inline: true },
              { name: 'Command', value: command, inline: true },
              { name: 'Time', value: time, inline: true }
            )
            .setColor(0x5865F2)],
        }).catch(() => {});
      }
      if ((isKick || isBan) && kickBanChannel) {
        await kickBanChannel.send({
          embeds: [new EmbedBuilder()
            .setTitle(isBan ? 'Player banned' : 'Player kicked')
            .addFields(
              { name: 'Command used by (Roblox)', value: playerName, inline: true },
              { name: 'Command', value: command, inline: true },
              { name: 'Time', value: time, inline: true }
            )
            .setColor(0xED4245)],
        }).catch(() => {});
      }
    }
  } catch (e) {
    console.error('ERLC commandlogs fetch failed:', e);
  }
}

async function updateVoiceChannelCounts(guild) {
  try {
    const memberCount = guild.memberCount;
    const staffCount = guild.members.cache.filter(m => m.roles.cache.has(STAFF_ROLE_ID)).size;
    const membersChannel = guild.channels.cache.get(MEMBER_COUNT_VC_ID);
    const staffChannel = guild.channels.cache.get(STAFF_COUNT_VC_ID);
    if (membersChannel && membersChannel.name !== `Members: ${memberCount}`) {
      await membersChannel.setName(`Members: ${memberCount}`);
    }
    if (staffChannel && staffChannel.name !== `Staff: ${staffCount}`) {
      await staffChannel.setName(`Staff: ${staffCount}`);
    }
  } catch (e) {
    console.error('Update voice channel counts failed:', e);
  }
}

const client = new Client({
  partials: [Partials.Channel, Partials.Message],
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ]
});

// Register slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('latency')
    .setDescription('Check the bot\'s latency')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('promote')
    .setDescription('Promotes a member of staff')
    .addUserOption(option =>
      option.setName('user').setDescription('User being promoted').setRequired(true))
    .addRoleOption(option =>
      option.setName('role').setDescription('New rank').setRequired(true))
    .addStringOption(option =>
      option.setName('reason').setDescription('Reason for promotion').setRequired(true))
    .addStringOption(option =>
      option.setName('note').setDescription('Optional note').setRequired(false))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('infract')
    .setDescription('Issue an infraction')
    .addUserOption(option =>
      option.setName('user').setDescription('User to issue infraction to').setRequired(true))
    .addStringOption(option =>
      option.setName('punishment').setDescription('Punishment (e.g. Strike 1)').setRequired(true))
    .addStringOption(option =>
      option.setName('reason').setDescription('Reason for infraction').setRequired(true))
    .addStringOption(option =>
      option.setName('notes').setDescription('Optional notes').setRequired(false))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('erlc')
    .setDescription('Run a command in ER:LC (e.g. :h Hi or :m Announcement)')
    .addStringOption(option =>
      option.setName('input').setDescription('Command to run (e.g. :h Hi)').setRequired(true))
    .toJSON()
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    console.log('Started refreshing application (/) commands.');

    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: commands },
    );

    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }
})();

// Handle button clicks (ban appeal flow)
client.on('interactionCreate', async interaction => {
  if (interaction.isButton()) {
    const id = interaction.customId;
    if (id === 'appeal_discord') {
      await interaction.reply({ content: `${WARNING_EMOJI} Unfortunately we do not unban people from the discord.`, ephemeral: false });
      return;
    }
    if (id === 'appeal_ingame') {
      pendingAppeals.set(interaction.user.id, { step: 'reason' });
      await interaction.reply({ content: 'What were you banned for?', ephemeral: false });
      return;
    }
    if (id.startsWith('accept_')) {
      const appealId = id.slice(7);
      const appeal = appealStore.get(appealId);
      if (!appeal) {
        await interaction.reply({ content: 'This appeal is no longer valid.', ephemeral: true });
        return;
      }
      const apiKey = (process.env.ERLC_API_KEY || '').trim();
      if (apiKey) {
        try {
          await fetch('https://api.policeroleplay.community/v1/server/command', {
            method: 'POST',
            headers: { 'Server-Key': apiKey, 'Content-Type': 'application/json', 'Accept': '*/*' },
            body: JSON.stringify({ command: `:unban ${appeal.robloxId}` }),
          });
        } catch (e) {
          console.error('ERLC unban failed:', e);
        }
      }
      try {
        const user = await client.users.fetch(appeal.userId);
        await user.send('You have been unbanned from the game server.');
      } catch (_) {}
      appealStore.delete(appealId);
      await interaction.reply({ content: 'Appeal accepted. User has been unbanned and DMed.', ephemeral: true });
      return;
    }
    if (id.startsWith('deny_')) {
      const appealId = id.slice(5);
      const appeal = appealStore.get(appealId);
      if (appeal) {
        try {
          const user = await client.users.fetch(appeal.userId);
          await user.send(`${WARNING_EMOJI} <@${appeal.userId}> Unfortunately your request to be unbanned has been denied.`);
        } catch (_) {}
        appealStore.delete(appealId);
      }
      await interaction.reply({ content: 'Appeal denied. User has been DMed.', ephemeral: true });
      return;
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.guild) {
    const userId = interaction.user.id;
    if (isSuspended(userId)) {
      return interaction.reply({
        content: `${WARNING_EMOJI} You are suspended from using bot commands for 24 hours.`,
        ephemeral: true,
      });
    }
  }

  if (interaction.commandName === 'latency') {
    const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true });
    const latency = sent.createdTimestamp - interaction.createdTimestamp;
    const apiLatency = Math.round(client.ws.ping);

    await interaction.editReply(
      `🏓 Pong!\n` +
      `📡 Bot Latency: ${latency}ms\n` +
      `🌐 API Latency: ${apiLatency}ms`
    );
    return;
  }

  if (interaction.commandName === 'promote') {
    if (!interaction.guild) {
      return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
    }
    try {
      await interaction.deferReply();
    } catch (e) {
      console.error('Promote deferReply failed:', e);
      return;
    }

    try {
      if (!interaction.member.roles.cache.has(PROMOTE_ALLOWED_ROLE_ID)) {
        recordPermissionDenied(interaction);
        return interaction.editReply({ content: NO_PERMISSION_MSG });
      }

      const targetUser = interaction.options.getUser('user');
      const newRole = interaction.options.getRole('role');
      const reason = interaction.options.getString('reason');
      const note = interaction.options.getString('note');

      let oldRankDisplay = 'None';
      try {
        const member = await interaction.guild.members.fetch(targetUser.id);
        const rolesExcluding = member.roles.cache
          .filter(r => r.id !== EXCLUDED_OLD_RANK_ROLE_ID && r.id !== interaction.guild.id)
          .sort((a, b) => b.position - a.position);
        const highestRole = rolesExcluding.first();
        if (highestRole) oldRankDisplay = `${highestRole}`;
      } catch (_) {
        oldRankDisplay = 'Unknown';
      }

      const embed = new EmbedBuilder()
        .setTitle('# Promotions')
        .addFields(
          { name: '\u200b', value: `• **Issued To:**\n${targetUser}`, inline: false },
          { name: '\u200b', value: `• **New Rank:**\n${newRole}`, inline: false },
          { name: '\u200b', value: `• **Old Rank:**\n${oldRankDisplay}`, inline: false },
          { name: '\u200b', value: `• **Reason:**\n${reason}`, inline: false }
        )
        .setFooter({ text: `** ${interaction.user.displayName || interaction.user.username} **` });

      if (note) {
        embed.addFields({ name: '\u200b', value: `• **Notes:**\n${note}`, inline: false });
      }

      await interaction.deleteReply();
      await interaction.channel.send({ embeds: [embed] });
    } catch (err) {
      console.error('Promote error:', err);
      try {
        await interaction.editReply({ content: 'Something went wrong. Check the bot console.' });
      } catch (_) {}
    }
  }

  if (interaction.commandName === 'infract') {
    if (!interaction.guild) {
      return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
    }
    try {
      await interaction.deferReply();
    } catch (e) {
      console.error('Infract deferReply failed:', e);
      return;
    }
    try {
      const targetUser = interaction.options.getUser('user');
      const punishment = interaction.options.getString('punishment');
      const reason = interaction.options.getString('reason');
      const notes = interaction.options.getString('notes');

      const embed = new EmbedBuilder()
        .setTitle('# Infractions')
        .addFields(
          { name: '\u200b', value: `• **Issued To:**\n${targetUser}`, inline: false },
          { name: '\u200b', value: `• **Punishment:**\n${punishment}`, inline: false },
          { name: '\u200b', value: `• **Reason:**\n*${reason}*`, inline: false }
        )
        .setFooter({ text: `** Approved By: ${interaction.user.displayName || interaction.user.username} **` });

      if (notes) {
        embed.addFields({ name: '\u200b', value: `• **Notes:**\n*${notes}*`, inline: false });
      }

      await interaction.deleteReply();
      await interaction.channel.send({ embeds: [embed] });
    } catch (err) {
      console.error('Infract error:', err);
      try {
        await interaction.editReply({ content: 'Something went wrong. Check the bot console.' });
      } catch (_) {}
    }
  }

  if (interaction.commandName === 'erlc') {
    if (!interaction.guild) {
      return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
    }
    if (!interaction.member.roles.cache.has(ERLC_ALLOWED_ROLE_ID)) {
      recordPermissionDenied(interaction);
      return interaction.reply({ content: NO_PERMISSION_MSG, ephemeral: true });
    }
    const apiKey = (process.env.ERLC_API_KEY || '').trim();
    if (!apiKey) {
      return interaction.reply({ content: 'ER:LC API key is not set in .env (ERLC_API_KEY).', ephemeral: true });
    }
    const input = interaction.options.getString('input');
    try {
      await interaction.deferReply();
      const res = await fetch('https://api.policeroleplay.community/v1/server/command', {
        method: 'POST',
        headers: {
          'Server-Key': apiKey,
          'Content-Type': 'application/json',
          'Accept': '*/*',
        },
        body: JSON.stringify({ command: input }),
      });
      if (res.status === 200 || res.status === 204) {
        await interaction.editReply({ content: `Command sent: \`${input}\`.` });
      } else if (res.status === 403) {
        await interaction.editReply({ content: 'Invalid API key or unauthorized.' });
      } else if (res.status === 422) {
        await interaction.editReply({ content: 'The server has no players in it.' });
      } else {
        const text = await res.text();
        await interaction.editReply({ content: `API error (${res.status}): ${text || res.statusText}` });
      }
    } catch (err) {
      console.error('ERLC command error:', err);
      try {
        await interaction.editReply({ content: `Failed to send command: ${err.message}` });
      } catch (_) {}
    }
  }
});

// DM: ban appeal intro or collect reason/robloxId
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  const isDM = !message.guild;
  if (!isDM) return;
  const userId = message.author.id;
  const pending = pendingAppeals.get(userId);

  if (pending) {
    if (pending.step === 'reason') {
      pending.reason = message.content || '*(no reason given)*';
      pending.step = 'robloxId';
      await message.channel.send('What is your Roblox ID?');
      return;
    }
    if (pending.step === 'robloxId') {
      const robloxId = (message.content || '').trim() || '*(not provided)*';
      pendingAppeals.delete(userId);
      const appealId = `appeal_${userId}_${Date.now()}`;
      appealStore.set(appealId, {
        userId,
        reason: pending.reason,
        robloxId: robloxId.replace(/\D/g, '') || robloxId,
        discordTag: message.author.tag,
        discordId: userId,
      });
      const embed = new EmbedBuilder()
        .setTitle('Ban Appeal')
        .addFields(
          { name: 'Discord User', value: `<@${userId}> (${message.author.tag})`, inline: false },
          { name: 'Discord ID', value: userId, inline: false },
          { name: 'What were you banned for?', value: pending.reason, inline: false },
          { name: 'Roblox ID', value: robloxId, inline: false }
        );
      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder().setCustomId(`accept_${appealId}`).setLabel('Accept').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`deny_${appealId}`).setLabel('Deny').setStyle(ButtonStyle.Danger)
        );
      const channel = await client.channels.fetch(APPEAL_CHANNEL_ID).catch(() => null);
      if (channel) await channel.send({ embeds: [embed], components: [row] });
      await message.channel.send('Your appeal has been submitted. You will be DMed when it is reviewed.');
      return;
    }
  }

  const intro = `** ${SERVER_LOGO_EMOJI} | Los Angeles Community Ban Appeal**\n\nHello! It seems you are trying to appeal your ban, please select one of the following options before continuing.`;
  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setCustomId('appeal_ingame').setLabel('Ingame').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('appeal_discord').setLabel('Discord').setStyle(ButtonStyle.Secondary)
    );
  try {
    const channel = message.channel?.partial ? await message.channel.fetch() : message.channel;
    if (channel) await channel.send({ content: intro, components: [row] });
  } catch (e) {
    console.error('DM ban appeal reply failed:', e);
  }
});

// Welcome on member join
client.on('guildMemberAdd', async member => {
  const guild = member.guild;
  const memberCount = guild.memberCount;
  const welcomeChannel = guild.channels.cache.get(WELCOME_CHANNEL_ID);

  if (welcomeChannel) {
    const welcomeText = `${WELCOME_EMOJI} Welcome ${member} for joining **${guild.name}!** You are our **${ordinal(memberCount)}** member!`;
    const button = new ButtonBuilder()
      .setCustomId('member_count_placeholder')
      .setEmoji({ id: '1470203576910348298' })
      .setLabel(String(memberCount))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true);
    const row = new ActionRowBuilder().addComponents(button);
    await welcomeChannel.send({ content: welcomeText, components: [row] });
  }

  try {
    const dmEmbed = new EmbedBuilder()
      .setDescription(
        `${WELCOME_EMOJI} Welcome to **${guild.name}!** Make sure you read our rules in\n\n` +
        `• https://discord.com/channels/1446166771492196555/1469455130138120416\n` +
        `• https://discord.com/channels/1446166771492196555/1469455131916505342\n\n` +
        `Also make sure you verify in: https://discord.com/channels/1446166771492196555/1469455128150151372 .\n\n` +
        `We would also appreciate if you support us in\n\n` +
        `• https://discord.com/channels/1446166771492196555/1469455136974966885\n` +
        `• https://discord.com/channels/1446166771492196555/1471295867603390484\n\n` +
        `**Sincerely | Los Angeles Community Ownership**`
      );
    await member.send({ embeds: [dmEmbed] });
  } catch (_) {
    // User may have DMs disabled
  }

  await updateVoiceChannelCounts(guild);
});

client.on('guildMemberRemove', async member => {
  await updateVoiceChannelCounts(member.guild);
});

// Bot ready event
client.once('ready', () => {
  console.log(`✅ Bot is ready! Logged in as ${client.user.tag}`);
  client.guilds.cache.each(guild => updateVoiceChannelCounts(guild));
  const erlcKey = (process.env.ERLC_API_KEY || '').trim();
  if (erlcKey) {
    setTimeout(() => fetchAndPostERLCLogs(client, erlcKey), 2000);
    setInterval(() => fetchAndPostERLCLogs(client, erlcKey), ERLC_LOGS_POLL_INTERVAL_MS);
  }
});

// Login to Discord
client.login(DISCORD_TOKEN);
