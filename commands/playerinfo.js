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
            .setTitle('🛡️ TSB INFO COLLECTOR // VERIFICATION PORTAL')
            .setDescription(
                'Welcome, operative! ⚡ Before you can access clan-exclusive content and raid operations, ' +
                'we need to **verify your identity** and confirm you are not affiliated with any enemy clan.\n\n' +
                '📍 **Why is this required?**\n' +
                '> This system protects our community by collecting essential player data and securing ' +
                'our ranks against potential **spies and infiltrators**. 🕵️‍♂️\n\n' +
                '🚨 **IMPORTANT NOTICE**\n' +
                '> Providing **false information** will result in an **immediate bounty** placed on your head. ' +
                'We take clan security **very seriously** — honesty is mandatory.\n\n' +
                '📋 **Information to Submit (all optional):**\n' +
                '> 1️⃣ **Roblox Username** — Your active Roblox identity\n' +
                '> 2️⃣ **Private Server (PS) Link** — Your personal server invite\n' +
                '> 3️⃣ **Kill Counts** — Your verified battlefield stats\n' +
                '> 4️⃣ **Friend List Screenshot** — To confirm clan safety\n\n' +
                '✅ Click the button below to begin. The process takes less than **2 minutes**!'
            )
            .setColor(0x9B59B6) // Sleek purple theme
            .setThumbnail(interaction.guild.iconURL({ size: 256 }))
            .setFooter({ text: 'Kakuzu Verification & Raid System', iconURL: interaction.client.user.displayAvatarURL({ size: 64 }) })
            .setTimestamp();

        const submitButton = new ButtonBuilder()
            .setCustomId('verify_submit_info')
            .setLabel('✅ Submit Info')
            .setStyle(ButtonStyle.Primary);

        const row = new ActionRowBuilder().addComponents(submitButton);

        await interaction.reply({
            embeds: [embed],
            components: [row]
        });
    }
};