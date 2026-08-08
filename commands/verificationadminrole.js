const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const raidStateManager = require('../handlers/raidStateManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('verificationadminrole')
        .setDescription('Manage which roles can accept/reject verification requests.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(sub =>
            sub
                .setName('add')
                .setDescription('Allow a role to accept/reject verification requests.')
                .addRoleOption(option => option.setName('role').setDescription('The role to add').setRequired(true))
        )
        .addSubcommand(sub =>
            sub
                .setName('remove')
                .setDescription('Remove a role from verification admins.')
                .addRoleOption(option => option.setName('role').setDescription('The role to remove').setRequired(true))
        )
        .addSubcommand(sub => sub.setName('list').setDescription('List the configured verification admin roles.')),
    async execute(interaction) {
        if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: '❌ **Access Denied.** You need the **Administrator** permission to manage verification admin roles.', flags: 64 });
        }

        const guildId = interaction.guild.id;
        const settings = raidStateManager.loadSettings(guildId);
        const roles = Array.isArray(settings.verificationAdminRoles) ? settings.verificationAdminRoles : [];
        const sub = interaction.options.getSubcommand();
        const role = interaction.options.getRole('role');

        if (sub === 'add') {
            if (!role) return interaction.reply({ content: '❌ Please select a role.', flags: 64 });
            if (role.id === guildId) return interaction.reply({ content: '❌ You cannot add the @everyone role.', flags: 64 });
            if (roles.includes(role.id)) return interaction.reply({ content: `⚠️ <@&${role.id}> is already a verification admin role.`, flags: 64 });
            roles.push(role.id);
            settings.verificationAdminRoles = roles;
            raidStateManager.saveSettings(guildId, settings);
            return interaction.reply({ content: `✅ <@&${role.id}> can now accept/reject verification requests.`, flags: 64 });
        }

        if (sub === 'remove') {
            if (!role) return interaction.reply({ content: '❌ Please select a role.', flags: 64 });
            const idx = roles.indexOf(role.id);
            if (idx === -1) return interaction.reply({ content: `⚠️ <@&${role.id}> is not a configured verification admin role.`, flags: 64 });
            roles.splice(idx, 1);
            settings.verificationAdminRoles = roles;
            raidStateManager.saveSettings(guildId, settings);
            return interaction.reply({ content: `✅ Removed <@&${role.id}> from verification admin roles.`, flags: 64 });
        }

        // list
        const embed = new EmbedBuilder()
            .setTitle('Verification Admin Roles')
            .setColor(0x9B59B6)
            .setDescription(
                roles.length
                    ? roles.map(id => `• <@&${id}> (\`${id}\`)`).join('\n')
                    : 'No verification admin roles configured yet. Only users with the **Administrator** permission can accept/reject currently.'
            )
            .setFooter({ text: 'Kakuzu Verification System', iconURL: interaction.client.user.displayAvatarURL({ size: 64 }) })
            .setTimestamp();
        return interaction.reply({ embeds: [embed], flags: 64 });
    }
};
