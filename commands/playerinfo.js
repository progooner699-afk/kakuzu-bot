const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('playerinfo')
        .setDescription('Deploy the TSB Info Collector verification portal embed.'),
    async execute(interaction) {
        const embed = new EmbedBuilder()
            .setTitle('🛡️ TSB INFO COLLECTOR // VERIFICATION PORTAL')
            .setDescription('Click the button below to submit your verification info.')
            .setColor(0x9B59B6)
            .setTimestamp();

        const button = new ButtonBuilder()
            .setCustomId('verify_submit_info')
            .setLabel('✅ Submit Info')
            .setStyle(ButtonStyle.Primary);

        const row = new ActionRowBuilder().addComponents(button);

        await interaction.reply({ embeds: [embed], components: [row] });
    }
};