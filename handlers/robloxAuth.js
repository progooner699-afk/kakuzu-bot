const BOT_COOKIE = process.env.BOT_ROBLOSECURITY;

async function getCsrfToken() {
  const res = await fetch('https://auth.roblox.com/v2/logout', {
    method: 'POST',
    headers: { Cookie: `.ROBLOSECURITY=${BOT_COOKIE}` }
  });
  return res.headers.get('x-csrf-token');
}

/**
  * Resolves a Roblox placeId + serverId into the hosting server's IP and data
 * center via the gamejoin API. Returns { machineAddress, publicAddress,
 * dataCenterId } when Roblox hands back a joinScript, otherwise logs the raw
 * body and returns null. `publicAddress` is extracted from
 * `UdmuxEndpoints[0].Address` (the public-facing IP) or null if unavailable.
 * @param {string|number} placeId
 * @param {string} serverId - the server instance's jobId / gameInstanceGuid
 * @returns {Promise<{machineAddress: string, publicAddress: string|null, dataCenterId: string}|null>}
 */
async function getServerIp(placeId, serverId) {
  async function attemptJoin() {
    const csrfToken = await getCsrfToken();
    const res = await fetch('https://gamejoin.roblox.com/v1/join-game-instance', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `.ROBLOSECURITY=${BOT_COOKIE}`,
        'X-CSRF-TOKEN': csrfToken,
        'User-Agent': 'Roblox/WinInet',
        'Referer': 'https://www.roblox.com/games/' + placeId
      },
      body: JSON.stringify({
        placeId: placeId,
        isTeleport: false,
        gameId: serverId,
        gameJoinAttemptId: serverId
      })
    });
    return res.json();
  }

  let response = await attemptJoin();
  let attempts = 0;

  while (!response.joinScript && response.status === 22 && attempts < 8) {
    console.log(`Queued (position ${response.queuePosition}), retrying... attempt ${attempts + 1}`);
    await new Promise(r => setTimeout(r, 1500));
    response = await attemptJoin();
    attempts++;
  }

  if (response && response.joinScript) {
    const udmuxAddress = response.joinScript.UdmuxEndpoints && response.joinScript.UdmuxEndpoints.length > 0
      ? response.joinScript.UdmuxEndpoints[0].Address
      : null;
    return {
      machineAddress: response.joinScript.MachineAddress,
      publicAddress: udmuxAddress,
      dataCenterId: response.joinScript.DataCenterId
    };
  }

  console.log('getServerIp final response (no joinScript):', response);
  return null;
}

module.exports = { BOT_COOKIE, getCsrfToken, getServerIp };