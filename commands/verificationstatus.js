const { SlashCommandBuilder } = require('discord.js');
const verificationDb = require('../handlers/verificationDb');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('verificationstatus')
        .setDescription('Check the verification status of a user.')
        .addUserOption(option =>
            option
                .setName('user')
                .setDescription('The user to check (defaults to yourself)')
                .setRequired(false)
        ),
    async execute(interaction) {
        const targetUser = interaction.options.getUser('user') || interaction.user;

        const isVerified = await verificationDb.isUserVerified(targetUser.id);

        if (isVerified) {
            return interaction.reply({
                content: `✅ ${targetUser} is fully verified and cleared of enemy clan ties.`,
                flags: 64
            });
        } else {
            return interaction.reply({
                content: `❌ ${targetUser} is NOT verified. High risk / Potential Spy. PLS GO VERIFY IN #INFO CHANNEL.`,
                flags: 64
            });
        }
    }
};