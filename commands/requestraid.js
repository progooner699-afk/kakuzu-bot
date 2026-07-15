const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('requestraid')
        .setDescription('Create a new raid request using the modal application workflow.'),
    async execute(interaction) {
        const buttonRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('request_raid')
                .setLabel('Request Raid')
                .setStyle(ButtonStyle.Primary)
        );

        await interaction.reply({
            content: [
                '```',
                '⚠️ RAID HELP PROTOCOL & RULES',
                '',
                'Please read these guidelines carefully before requesting backup. Abuse of the system will result in a blacklist.',
                '',
                '⛔ WHAT NOT TO DO',
                '- 🛑 No Raid Spamming: Do not open multiple help requests for the same server or spam the command.',
                '- 🛑 No False Flagging: Do not use the help system if **YOU** initiated the fight, jumped them first, or interrupted their grind. This system is for defense only.',
                '- 🛑 No Toxicity: Do not call for backup just to toxic-camp or harass players who aren\'t violating game rules.',
                '',
                '✅ WHAT TO DO (LEGIT REASONS TO CALL FOR HELP)',
                '- ⚔️ Server Sniped: A rival clan intentionally joined your server specifically to target and clear your members.',
                '- 🚜 Grind Interrupted: You/your allies were minding your own business farming, and a toxic group team-attacked to steal your spot.',
                '- 🚨 Outnumbered: You are facing an organized group of teamers or an enemy clan and legitimately require numbers to defend your position.',
                '',
                '💡 Quick Reminder',
                'Always provide accurate teamer counts and enemy clan names so helpers know exactly what loadout or strategy to bring!',
                '```',
                '',
                'Click the button below to open the raid application form.'
            ].join('\n'),
            components: [buttonRow]
        });
    }
};
