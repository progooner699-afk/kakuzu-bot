const { SlashCommandBuilder, EmbedBuilder, ChannelType } = require('discord.js');
const fs = require('fs');
const path = require('path');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('info')
        .setDescription('Display Kakuzu system information'),
    async execute(interaction) {
        const settingsPath = path.join(__dirname, '../data/settings.json');
        let settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

        // Create the embed with the new design
        const infoEmbed = new EmbedBuilder()
            .setTitle('⚙️ KAKUZU // SYSTEM INFO')
            .setDescription('**NAME:** Kakuzu\n\n**DESCRIPTION:** Kakuzu is a custom-built moderation and raid management system designed exclusively for Akatsuki Clan and its allied clans.')
            .setColor('#FF6600')
            .addFields(
                {
                    name: '🛠️ MODULES',
                    value: '🛡️ Moderation System\n⚔️ Raid Applications & Alerts\n🎭 Auto Role Assignment\n📊 Daily, Weekly, & Monthly Leaderboards\n📈 Raid Activity Tracking\n👥 Clan Management Utilities',
                    inline: false
                },
                {
                    name: '🎯 PURPOSE & ACCESS',
                    value: '🚀 **Purpose:** To streamline raid requests, manage member activity, improve clan coordination, and maintain server organization.\n\n🔒 **Access:** Akatsuki Clan & Authorized Allied Clans',
                    inline: false
                },
                {
                    name: '💻 SYSTEM STATUS',
                    value: '🟢 **Status:** Operational\n👑 **Developer:** nigachad / yourdad043\n📦 **Build:** Akatsuki Clan Edition',
                    inline: false
                }
            )
            .setFooter({ text: 'Kakuzu System • v1.0.0' })
            .setTimestamp();

        try {
            // Check if we have a saved info message ID and info channel
            if (settings.infoMessageId && settings.infoChannel) {
                try {
                    const channel = await interaction.client.channels.fetch(settings.infoChannel);
                    const message = await channel.messages.fetch(settings.infoMessageId);
                    
                    // Edit the existing message
                    await message.edit({ embeds: [infoEmbed] });
                    await interaction.reply({ content: '✅ Info message updated successfully!', ephemeral: true });
                    return;
                } catch (error) {
                    console.log('Could not fetch previous message, creating a new one...');
                }
            }

            // Get the channel to send/edit the message in
            let targetChannel = interaction.channel;
            
            // If there's a designated info channel in settings, use it
            if (settings.infoChannel) {
                try {
                    targetChannel = await interaction.client.channels.fetch(settings.infoChannel);
                } catch (error) {
                    console.log('Info channel not found, using current channel');
                    targetChannel = interaction.channel;
                }
            }

            // Send the new message
            const sentMessage = await targetChannel.send({ embeds: [infoEmbed] });

            // Save the message ID and channel to settings
            settings.infoMessageId = sentMessage.id;
            settings.infoChannel = targetChannel.id;
            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4));

            await interaction.reply({ content: '✅ Info message created successfully!', ephemeral: true });
        } catch (error) {
            console.error('Error in info command:', error);
            await interaction.reply({ content: '❌ An error occurred while processing the info command.', ephemeral: true });
        }
    }
};
