const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('verification')
        .setDescription('Deploy the TSB Info Collector verification portal embed.'),
    async execute(interaction) {
        const codeBlock = [
            'WELCOME, OPERATIVE ⚡',
            '',
            'Before accessing clan-exclusive content and raid operations,',
            'we must verify your identity and confirm you are not',
            'affiliated with any enemy clan.',
            '',
            '━━━━━━━━━━━━━━━━━━',
            '',
            '📍 WHY IS THIS REQUIRED?',
            '',
            'This system protects our community by collecting essential',
            'player data and securing our ranks against potential spies',
            'and infiltrators. 🕵️‍♂️',
            '',
            '━━━━━━━━━━━━━━━━━━',
            '',
            '🚨 IMPORTANT NOTICE',
            '',
            'Providing false information will result in an immediate',
            'bounty placed on your head. We take clan security very',
            'seriously — honesty is mandatory.',
            '',
            '━━━━━━━━━━━━━━━━━━',
            '',
            '📋 INFORMATION TO SUBMIT (ALL OPTIONAL)',
            '',
            '1️⃣ Roblox Username        : Your active Roblox identity',
            '2️⃣ Private Server Link    : Your personal server invite',
            '3️⃣ Kill Counts            : Your verified battlefield stats',
            '4️⃣ Friend List Screenshot : To confirm clan safety',
            '',
            '━━━━━━━━━━━━━━━━━━',
            '',
            '✅ Click the button below to begin.',
            '   The process takes less than 2 minutes!'
        ].join('\n');

        const embed = new EmbedBuilder()
            .setTitle('🛡️ TSB INFO COLLECTOR // VERIFICATION PORTAL')
            .setDescription('```yaml\n' + codeBlock + '\n```')
            .setColor(0x9B59B6)
            .setThumbnail(interaction.client.user.displayAvatarURL({ size: 256 }))
            .setFooter({ text: 'Kakuzu Verification & Raid System', iconURL: interaction.client.user.displayAvatarURL({ size: 64 }) })
            .setTimestamp();

        const button = new ButtonBuilder()
            .setCustomId('verify_submit_info')
            .setLabel('✅ Submit Info')
            .setStyle(ButtonStyle.Primary);

        const row = new ActionRowBuilder().addComponents(button);

        await interaction.reply({ embeds: [embed], components: [row] });
    }
};