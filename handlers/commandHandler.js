const fs = require('fs');
const path = require('path');
const { Collection } = require('discord.js');

// 'deploy-commands.js' is the registration CLI (exports run/registerGuildCommands,
// no 'data'), not a slash command. Loading it first in getCommandDataArray()
// creates a harmless circular require — exclude it from command discovery.
const NON_COMMAND_FILES = new Set(['deploy-commands.js']);

function listCommandFiles() {
    return fs.readdirSync(path.join(__dirname, '..', 'commands'))
        .filter(file => file.endsWith('.js') && !NON_COMMAND_FILES.has(file));
}

function loadCommands(client) {
    const commands = new Collection();
    const commandsPath = path.join(__dirname, '..', 'commands');

    for (const file of listCommandFiles()) {
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
    const data = [];

    for (const file of listCommandFiles()) {
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
