const fs = require('fs');
const path = require('path');
const { Collection } = require('discord.js');

function loadCommands(client) {
    const commands = new Collection();
    const commandsPath = path.join(__dirname, '..', 'commands');
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        const command = require(filePath);
        if (command.data && command.execute) {
            commands.set(command.data.name, command);
        }
    }

    client.commands = commands;
    return commands;
}

function getCommandDataArray() {
    const commandsPath = path.join(__dirname, '..', 'commands');
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
    const data = [];

    for (const file of commandFiles) {
        const command = require(path.join(commandsPath, file));
        if (command.data) {
            data.push(command.data.toJSON());
        }
    }

    return data;
}

module.exports = {
    loadCommands,
    getCommandDataArray
};
