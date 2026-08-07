const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const raidStateManager = require('../handlers/raidStateManager');

function normalizeRegionInput(region) {
    const value = String(region || '').trim().toUpperCase();
    if (value === 'AS') return 'ASIA';
    if (value === 'EUROPE') return 'EU';
    if (value === 'US' || value === 'USA' || value === 'NORTH AMERICA') return 'NA';
    if (value === 'SOUTH AMERICA') return 'SA';
    if (value === 'AUS' || value === 'AUSTRALIA') return 'AUST';
    if (value === 'MIDDLE' || value === 'MIDDLE EAST' || value === 'MIDDLE_EAST') return 'MIDDLE_EAST';
    if (value === 'AFRICA') return 'AFRICA';
    if (value === 'OCEANIA' || value === 'OC' || value === 'OCE') return 'OCEANIA';
    return value;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setregionping')
        .setDescription('Configure region ping roles for this server (Admin only)')
        .addSubcommand(sub => sub
            .setName('add')
            .setDescription('Add a role to a region')
            .addStringOption(opt => opt.setName('region').setDescription('Region name (e.g. ASIA, EU, NA)').setRequired(true))
            .addRoleOption(opt => opt.setName('role').setDescription('Role to add').setRequired(true))
        )
        .addSubcommand(sub => sub
            .setName('remove')
            .setDescription('Remove a role from a region')
            .addStringOption(opt => opt.setName('region').setDescription('Region name').setRequired(true))
            .addRoleOption(opt => opt.setName('role').setDescription('Role to remove').setRequired(true))
        )
        .addSubcommand(sub => sub
            .setName('view')
            .setDescription('View roles configured for a region')
            .addStringOption(opt => opt.setName('region').setDescription('Region name').setRequired(true))
        )
        .addSubcommand(sub => sub
            .setName('clear')
            .setDescription('Clear all roles configured for a region')
            .addStringOption(opt => opt.setName('region').setDescription('Region name').setRequired(true))
        ),

    async execute(interaction) {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.reply({ content: '❌ You must be an Administrator to use this command.', ephemeral: true });
        }

        const sub = interaction.options.getSubcommand();
        const regionRaw = interaction.options.getString('region');
        const normalized = normalizeRegionInput(regionRaw);
        const settings = raidStateManager.loadSettings(interaction.guild.id);
        settings.regionPings = settings.regionPings || {};

        if (sub === 'add') {
            const role = interaction.options.getRole('role');
            const arr = settings.regionPings[normalized] || [];
            if (!arr.includes(role.id)) arr.push(role.id);
            settings.regionPings[normalized] = arr;
            raidStateManager.saveSettings(interaction.guild.id, settings);
            return interaction.reply({ content: `✅ Added role ${role} to region **${normalized}**.`, ephemeral: true });
        }

        if (sub === 'remove') {
            const role = interaction.options.getRole('role');
            const arr = settings.regionPings[normalized] || [];
            const idx = arr.indexOf(role.id);
            if (idx === -1) return interaction.reply({ content: `⚠️ Role ${role} is not configured for region **${normalized}**.`, ephemeral: true });
            arr.splice(idx, 1);
            settings.regionPings[normalized] = arr;
            raidStateManager.saveSettings(interaction.guild.id, settings);
            return interaction.reply({ content: `✅ Removed role ${role} from region **${normalized}**.`, ephemeral: true });
        }

        if (sub === 'view') {
            const arr = settings.regionPings[normalized] || [];
            if (!arr.length) return interaction.reply({ content: `ℹ️ No roles configured for region **${normalized}**.`, ephemeral: true });
            const mentions = arr.map(id => `<@&${id}>`).join(' ');
            return interaction.reply({ content: `Roles for **${normalized}**:\n${mentions}`, ephemeral: true });
        }

        if (sub === 'clear') {
            settings.regionPings[normalized] = [];
            raidStateManager.saveSettings(interaction.guild.id, settings);
            return interaction.reply({ content: `✅ Cleared all roles for region **${normalized}**.`, ephemeral: true });
        }

        return interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
    }
};
