const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('playerinfo')
        .setDescription('Deploy the TSB Info Collector verification portal embed.'),
    async execute(interaction) {
        // Server Owner only check
        if (interaction.user.id !== interaction.guild.ownerId) {
            return interaction.reply({
                content: '❌ **Access Denied.** Only the Server Owner can deploy the verification portal.',
                flags: 64
            });
        }

        const embed = new EmbedBuilder()
            .setTitle('TSB Info Collector - Verification Portal')
            .setDescription(
                '⚠️ **NOTE:** This system is designed to collect essential player data and verify your identity to ensure security. Any false information will result in an immediate bounty on your head. We must assure you are not from an enemy clan.\n\n' +
                '**Required Information to Gather:**\n' +
                '1. Roblox Username\n' +
                '2. Roblox Private Server (PS) Link\n' +
                '3. Kill Counts\n' +
                '4. Screenshot of your Roblox Friend List (to verify clan safety)'
            )
            .setColor(0xFF0000)
            .setFooter({ text: 'Kakuzu Verification System' });

        const submitButton = new ButtonBuilder()
            .setCustomId('verify_submit_info')
            .setLabel('Submit Info')
            .setStyle(ButtonStyle.Danger);

        const row = new ActionRowBuilder().addComponents(submitButton);

        await interaction.reply({
            embeds: [embed],
            components: [row]
        });
    }
};