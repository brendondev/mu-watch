import 'dotenv/config';
import fetch from 'node-fetch';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, Events } from 'discord.js';

const {
  DISCORD_BOT_TOKEN,
  DISCORD_CLIENT_ID,
  GH_PAT_BOT,  // PAT com scopes: repo, workflow
  GH_OWNER,    // ex: "seu-user-ou-org"
  GH_REPO,     // ex: "seu-repo"
  GH_WORKFLOW, // ex: "mudream.yml" (nome do arquivo do workflow)
  GH_BRANCH = 'main'
} = process.env;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('mudream')
      .setDescription('Roda o watcher agora (sob demanda)')
      .addStringOption(o =>
        o.setName('nicks')
         .setDescription('Lista separada por vírgula (ex: OmegaForce,Yeiyeii) — opcional')
         .setRequired(false)
      )
      .toJSON()
  ];
  const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);
  await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
}

async function triggerWorkflow(nicks = '') {
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/${GH_WORKFLOW}/dispatches`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'authorization': `token ${GH_PAT_BOT}`,
      'accept': 'application/vnd.github+json',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ ref: GH_BRANCH, inputs: { nicks } })
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
}

client.once(Events.ClientReady, async () => {
  console.log(`Bot online como ${client.user.tag}`);
  try { await registerCommands(); } catch (e) { console.error('Register fail:', e); }
});

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() || i.commandName !== 'mudream') return;
  const nicks = i.options.getString('nicks') || '';
  await i.reply({ content: `✅ Disparando watcher ${nicks ? `para: ${nicks}` : '(watchlist completa)'}`, ephemeral: true });
  try {
    await triggerWorkflow(nicks);
    await i.followUp({ content: '🚀 Workflow acionado.', ephemeral: true });
  } catch (e) {
    await i.followUp({ content: `❌ Erro: ${e.message}`, ephemeral: true });
  }
});

client.login(DISCORD_BOT_TOKEN);
