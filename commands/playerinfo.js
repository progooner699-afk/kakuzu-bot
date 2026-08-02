const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('playerinfo')
        .setDescription('Deploy the TSB Info Collector verification portal embed.'),
    async execute(interaction) {
        // Robust owner/admin check (fetchOwner avoids null ownerId cache issues)
        let isOwner = false;
        try {
            const owner = await interaction.guild.fetchOwner().catch(() => null);
            isOwner = owner?.id === interaction.user.id;
        } catch {
            isOwner = false;
        }
        const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || false;

        if (!isOwner && !isAdmin) {
            return interaction.reply({
                content: '❌ **Access Denied.** Only the Server Owner can deploy the verification portal.',
                flags: 64
            });
        }

        const embed = new EmbedBuilder()
            .setTitle('🛡️ TSB INFO COLLECTOR // VERIFICATION PORTAL')
            .setColor(0x9B59B6) // Sleek purple (also renders as the thick left border line)
            .setDescription(
                '```diff\n' +
                '+ WELCOME, OPERATIVE ⚡\n' +
                '```\n' +
                '```css\n' +
                'Before accessing clan-exclusive content and raid operations,\n' +
                'we must verify your identity and confirm you are not\n' +
                'affiliated with any enemy clan.\n' +
                '```\n\n' +
                '━━━━━━━━━━━━━━━━━━\n\n' +
                '```fix\n' +
                '📍 WHY IS THIS REQUIRED?\n' +
                '```\n' +
                '```yaml\n' +
                'This system protects our community by collecting essential\n' +
                'player data and securing our ranks against potential spies\n' +
                'and infiltrators. 🕵️‍♂️\n' +
                '```\n\n' +
                '━━━━━━━━━━━━━━━━━━\n\n' +
                '```diff\n' +
                '- 🚨 IMPORTANT NOTICE\n' +
                '```\n' +
                '```yaml\n' +
                'Providing false information will result in an immediate\n' +
                'bounty placed on your head. We take clan security very\n' +
                'seriously — honesty is mandatory.\n' +
                '```\n\n' +
                '━━━━━━━━━━━━━━━━━━\n\n' +
                '```ini\n' +
                '[ 📋 INFORMATION TO SUBMIT (ALL OPTIONAL) ]\n' +
                '```\n' +
                '```prolog\n' +
                '1️⃣ Roblox Username        : Your active Roblox identity\n' +
                '2️⃣ Private Server Link    : Your personal server invite\n' +
                '3️⃣ Kill Counts            : Your verified battlefield stats\n' +
                '4️⃣ Friend List Screenshot : To confirm clan safety\n' +
                '```\n\n' +
                '━━━━━━━━━━━━━━━━━━\n\n' +
                '```bash\n' +
                '✅ Click the button below to begin.\n' +
                '   The process takes less than 2 minutes!\n' +
                '```'
            )
            .setThumbnail(interaction.guild.iconURL({ size: 256 }) || interaction.client.user.displayAvatarURL({ size: 256 }))
            .setFooter({ text: 'Kakuzu Verification & Raid System', iconURL: interaction.client.user.displayAvatarURL({ size: 64 }) })
            .setTimestamp();

        // Saitama anime GIF for aesthetics (verified working URL)
        embed.setImage('https://media.giphy.com/media/3o7aD2saalBwwftBIY/giphy.gif');

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