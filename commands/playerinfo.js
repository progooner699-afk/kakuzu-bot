const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('playerinfo')
        .setDescription('Deploy the TSB Info Collector verification portal embed.'),
    async execute(interaction) {
        try {
            // Permission check: owner or admin
            const isOwner = interaction.user.id === interaction.guild.ownerId;
            const isAdmin = interaction.member?.permissions?.has(PermissionFlagsBits.Administrator) || false;

            if (!isOwner && !isAdmin) {
                return interaction.reply({
                    content: '❌ **Access Denied.** Only the Server Owner can deploy the verification portal.',
                    flags: 64
                });
            }

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
                .setColor(0x9B59B6)
                .setDescription('```yaml\n' + codeBlock + '\n```')
                .setThumbnail(interaction.guild.iconURL({ size: 256 }) || interaction.client.user.displayAvatarURL({ size: 256 }))
                .setFooter({ text: 'Kakuzu Verification & Raid System', iconURL: interaction.client.user.displayAvatarURL({ size: 64 }) })
                .setTimestamp();

            const submitButton = new ButtonBuilder()
                .setCustomId('verify_submit_info')
                .setLabel('✅ Submit Info')
                .setStyle(ButtonStyle.Primary);

            const row = new ActionRowBuilder().addComponents(submitButton);

            return await interaction.reply({
                embeds: [embed],
                components: [row]
            });
        } catch (error) {
            console.error('playerinfo command error:', error);
            if (!interaction.replied && !interaction.deferred) {
                return interaction.reply({ content: '❌ An error occurred while deploying the verification portal.', flags: 64 }).catch(() => null);
            }
        }
    }
};