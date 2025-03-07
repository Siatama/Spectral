'use strict';

/** @type {typeof import('../../lib/fs').FS} */
const FS = require(/** @type {any} */('../../.lib-dist/fs')).FS;
const TICKET_FILE = 'config/tickets.json';
const TICKET_CACHE_TIME = 24 * 60 * 60 * 1000; // 24 hours
const TICKET_BAN_DURATION = 48 * 60 * 60 * 1000; // 48 hours

/**
 * @typedef {Object} TicketState
 * @property {string} creator
 * @property {string} userid
 * @property {boolean} open
 * @property {boolean} active
 * @property {string} type
 * @property {number} created
 * @property {string?} claimed
 * @property {boolean} escalated
 * @property {string} ip
 * @property {string} [escalator]
 */
/**
 * @typedef {Object} BannedTicketState
 * @property {string} banned
 * @property {string} [creator]
 * @property {string} [userid]
 * @property {boolean} [open]
 * @property {string} [type]
 * @property {number} created
 * @property {string?} [claimed]
 * @property {boolean} [escalated]
 * @property {string} ip
 * @property {string} [escalator]
 * @property {string} [name]
 * @property {string} by
 * @property {string} reason
 * @property {number} expires
 */
/** @typedef {'approved' | 'valid' | 'assisted' | 'denied' | 'invalid' | 'unassisted' | 'ticketban' | 'deleted'} TicketResult */

/** @type {{[k: string]: TicketState}} */
let tickets = {};
/** @type {{[k: string]: BannedTicketState}} */
let ticketBans = {};

try {
	let ticketData = JSON.parse(FS(TICKET_FILE).readSync());
	for (let t in ticketData) {
		const ticket = ticketData[t];
		if (ticket.banned) {
			if (ticket.expires <= Date.now()) continue;
			ticketBans[t] = ticket;
		} else {
			if (ticket.created + TICKET_CACHE_TIME <= Date.now() && !ticket.open) {
				continue;
			}
			// Close open tickets after a restart
			// (i.e. if the server has been running for less than a minute)
			if (ticket.open && process.uptime() <= 60) ticket.open = false;
			tickets[t] = ticket;
		}
	}
} catch (e) {
	if (e.code !== 'ENOENT') throw e;
}

function writeTickets() {
	FS(TICKET_FILE).writeUpdate(() => (
		JSON.stringify(Object.assign({}, tickets, ticketBans))
	));
}

/**
 * @param {string} line
 */
function writeStats(line) {
	// ticketType\ttotalTime\ttimeToFirstClaim\tinactiveTime\tresolution\tresult\tstaff,userids,seperated,with,commas
	const date = new Date();
	const month = Chat.toTimestamp(date).split(' ')[0].split('-', 2).join('-');
	try {
		FS(`logs/tickets/${month}.tsv`).appendSync(line + '\n');
	} catch (e) {
		if (e.code !== 'ENOENT') throw e;
	}
}

class HelpTicket extends Rooms.RoomGame {
	/**
	 * @param {ChatRoom} room
	 * @param {TicketState} ticket
	 */
	constructor(room, ticket) {
		super(room);
		this.title = "Help Ticket - " + ticket.type;
		this.gameid = /** @type {ID} */ ("helpticket");
		this.allowRenames = true;
		this.ticket = ticket;
		/** @type {string[]} */
		this.claimQueue = [];
		/* Stats */
		/** @type {Set<ID>} */
		this.involvedStaff = new Set();
		this.createTime = Date.now();
		this.activationTime = (ticket.active ? this.createTime : 0);
		this.emptyRoom = false;
		this.firstClaimTime = 0;
		this.unclaimedTime = 0;
		this.lastUnclaimedStart = (ticket.active ? this.createTime : 0);
		this.closeTime = 0;
		/** @type {'unknown' | 'dead' | 'unresolved' | 'resolved'} */
		this.resolution = 'unknown';
		/** @type {TicketResult?} */
		this.result = null;
	}

	/**
	 * @param {User} user
	 * @param {Connection} connection
	 */
	onJoin(user, connection) {
		if (!this.ticket.open) return false;
		if (!user.isStaff || user.userid === this.ticket.userid) {
			if (this.emptyRoom) this.emptyRoom = false;
			this.addPlayer(user);
			return false;
		}
		if (this.ticket.escalated && !user.can('declare')) return false;
		if (!this.ticket.claimed) {
			this.ticket.claimed = user.name;
			if (!this.firstClaimTime) {
				this.firstClaimTime = Date.now();
				// I'd use the player list for this, but it dosen't track DCs so were checking the userlist
				// Non-staff users in the room currently (+ the ticket creator even if they are staff)
				let users = Object.entries(this.room.users).filter(u => {
					return !((u[1].isStaff && u[1].userid !== this.ticket.userid) || !u[1].named);
				});
				if (!users.length) this.emptyRoom = true;
			}
			if (!this.ticket.active) {
				this.ticket.active = true;
				this.activationTime = Date.now();
			} else {
				this.unclaimedTime += Date.now() - this.lastUnclaimedStart;
				this.lastUnclaimedStart = 0; // Set back to 0 so we know that it was active when closed
			}
			tickets[this.ticket.userid] = this.ticket;
			writeTickets();
			this.modnote(user, `${user.name} claimed this ticket.`);
			notifyStaff(this.ticket.escalated);
		} else {
			this.claimQueue.push(user.name);
		}
	}

	/**
	 * @param {User} user
	 * @param {ID} oldUserid
	 */
	onLeave(user, oldUserid) {
		const player = this.playerTable[oldUserid || user.userid];
		if (player) {
			this.removePlayer(player);
			return;
		}
		if (!this.ticket.open) return;
		if (toID(this.ticket.claimed) === user.userid) {
			if (this.claimQueue.length) {
				this.ticket.claimed = this.claimQueue.shift() || null;
				this.modnote(user, `This ticket is now claimed by ${this.ticket.claimed}.`);
			} else {
				this.ticket.claimed = null;
				this.lastUnclaimedStart = Date.now();
				this.modnote(user, `This ticket is no longer claimed.`);
				notifyStaff(this.ticket.escalated);
			}
			tickets[this.ticket.userid] = this.ticket;
			writeTickets();
		} else {
			let index = this.claimQueue.map(toID).indexOf(/** @type {ID} */(user.userid));
			if (index > -1) this.claimQueue.splice(index, 1);
		}
	}

	/**
	 * @param {string} message
	 * @param {User} user
	 */
	onLogMessage(message, user) {
		if (!this.ticket.open) return;
		if (user.isStaff && this.ticket.userid !== user.userid) this.involvedStaff.add(user.userid);
		if (this.ticket.active) return;
		const blockedMessages = [
			'hi', 'hello', 'hullo', 'hey', 'yo', 'ok',
			'hesrude', 'shesrude', 'hesinappropriate', 'shesinappropriate', 'heswore', 'sheswore', 'help',
		];
		if ((!user.isStaff || this.ticket.userid === user.userid) && blockedMessages.includes(toID(message))) {
			this.room.add(`|c|~Staff|Hello! The global staff team would be happy to help you, but you need to explain what's going on first.`);
			this.room.add(`|c|~Staff|Please post the information I requested above so a global staff member can come to help.`);
			this.room.update();
			return false;
		}
		if ((!user.isStaff || this.ticket.userid === user.userid) && !this.ticket.active) {
			this.ticket.active = true;
			this.activationTime = Date.now();
			this.lastUnclaimedStart = Date.now();
			notifyStaff(this.ticket.escalated);
		}
	}

	/**
	 * @param {User} user
	 */
	forfeit(user) {
		if (!(user.userid in this.playerTable)) return;
		this.removePlayer(user);
		if (!this.ticket.open) return;
		this.modnote(user, `${user.name} is no longer interested in this ticket.`);
		if (this.playerCount - 1 > 0) return; // There are still users in the ticket room, dont close the ticket
		this.close(user, !!(this.firstClaimTime));
		return true;
	}

	/**
	 * @param {boolean} sendUp
	 * @param {User} staff
	 */
	escalate(sendUp, staff) {
		this.ticket.claimed = null;
		this.claimQueue = [];
		this.lastUnclaimedStart = Date.now();
		if (sendUp) {
			this.ticket.escalated = true;
			tickets[this.ticket.userid] = this.ticket;
			this.modnote(staff, `${staff.name} escalated this ticket to upper staff.`);
			notifyStaff(true);
		} else {
			this.modnote(staff, `${staff.name} escalated this ticket.`);
		}
		this.ticket.escalator = staff.name;
		this.ticket.created = Date.now(); // Bump the ticket so it shows as the newest
		writeTickets();
		notifyStaff();
	}

	/**
	 * @param {User} user
	 * @param {string} text
	 */
	modnote(user, text) {
		this.room.addByUser(user, text);
		this.room.modlog(`(${this.room.id}) ${text}`);
	}

	/**
	 * @return {string}
	 */
	getPreview() {
		if (!this.ticket.active) return `title="The ticket creator has not spoken yet."`;
		let hoverText = [];
		for (let i = this.room.log.log.length - 1; i >= 0; i--) {
			let entry = this.room.log.log[i].split('|');
			entry.shift(); // Remove empty string
			if (!['c', 'c:'].includes(entry[0])) continue;
			if (entry[0] === 'c:') entry.shift(); // c: includes a timestamp and needs an extra shift
			entry.shift();
			let user = entry.shift();
			let message = entry.join('|');
			message = message.startsWith('/log ') ? message.slice(5) : `${user}: ${message}`;
			hoverText.push(Chat.html`${message}`);
			if (hoverText.length >= 3) break;
		}
		if (!hoverText.length) return `title="The ticket creator has not spoken yet."`;
		return `title="${hoverText.reverse().join(`&#10;`)}"`;
	}

	/**
	 * @param {User} staff
	 * @param {boolean | 'ticketban' | 'deleted'} result
	 */
	close(staff, result) {
		this.room.isHelp = 'closed';
		this.ticket.open = false;
		tickets[this.ticket.userid] = this.ticket;
		writeTickets();
		this.modnote(staff, `${staff.name} closed this ticket.`);
		notifyStaff(this.ticket.escalated);
		this.room.pokeExpireTimer();
		for (const ticketGameUser of Object.values(this.playerTable)) {
			this.removePlayer(ticketGameUser);
			const user = Users.get(ticketGameUser.userid);
			if (user) user.updateSearch();
		}
		if (!this.involvedStaff.size) {
			if (staff.isStaff && staff.userid !== this.ticket.userid) {
				this.involvedStaff.add(staff.userid);
			} else {
				this.involvedStaff.add(toID(this.ticket.claimed));
			}
		}
		this.writeStats(result);
	}

	/**
	 * @param {boolean | 'ticketban' | 'deleted'} result
	 */
	writeStats(result) {
		// Only run when a ticket is closed/banned/deleted
		this.closeTime = Date.now();
		if (this.lastUnclaimedStart) this.unclaimedTime += this.closeTime - this.lastUnclaimedStart;
		if (!this.ticket.active) {
			this.resolution = "dead";
		} else if (!this.firstClaimTime || this.emptyRoom) {
			this.resolution = "unresolved";
		} else {
			this.resolution = "resolved";
		}
		if (typeof result === 'boolean') {
			switch (this.ticket.type) {
			case 'Appeal':
			case 'IP-Appeal':
			case 'ISP-Appeal':
				this.result = (result ? 'approved' : 'denied');
				break;
			case 'PM Harassment':
			case 'Battle Harassment':
			case 'Inappropriate Username / Status Message':
			case 'Inappropriate Pokemon Nicknames':
				this.result = (result ? 'valid' : 'invalid');
				break;
			case 'Public Room Assistance Request':
			case 'Other':
			default:
				this.result = (result ? 'assisted' : 'unassisted');
				break;
			}
		} else {
			this.result = result;
		}
		let firstClaimWait = 0;
		if (this.activationTime) firstClaimWait = (this.firstClaimTime ? this.firstClaimTime : this.closeTime) - this.activationTime;
		// Write to TSV
		// ticketType\ttotalTime\ttimeToFirstClaim\tinactiveTime\tresolution\tresult\tstaff,userids,seperated,with,commas
		const line = `${this.ticket.type}\t${(this.closeTime - this.createTime)}\t${firstClaimWait}\t${this.unclaimedTime}\t${this.resolution}\t${this.result}\t${Array.from(this.involvedStaff.entries()).map(s => s[0]).join(',')}`;
		writeStats(line);
	}

	/**
	 * @param {User} staff
	 */
	deleteTicket(staff) {
		this.close(staff, 'deleted');
		this.modnote(staff, `${staff.name} deleted this ticket.`);
		delete tickets[this.ticket.userid];
		writeTickets();
		notifyStaff(this.ticket.escalated);
		this.room.destroy();
	}
}

const NOTIFY_ALL_TIMEOUT = 5 * 60 * 1000;
const NOTIFY_ASSIST_TIMEOUT = 60 * 1000;
/** @type {{[k: string]: NodeJS.Timer?}} */
let unclaimedTicketTimer = {upperstaff: null, staff: null};
/** @type {{[k: string]: number}} */
let timerEnds = {upperstaff: 0, staff: 0};
/**
 * @param {boolean} upper
 * @param {boolean} hasUnclaimed
 * @param {boolean} hasAssistRequest
 */
function pokeUnclaimedTicketTimer(upper, hasUnclaimed, hasAssistRequest) {
	const room = Rooms.get(upper ? 'upperstaff' : 'staff');
	if (!room) return;
	if (hasUnclaimed && !unclaimedTicketTimer[room.id]) {
		unclaimedTicketTimer[room.id] = setTimeout(() => notifyUnclaimedTicket(upper, hasAssistRequest), hasAssistRequest ? NOTIFY_ASSIST_TIMEOUT : NOTIFY_ALL_TIMEOUT);
		timerEnds[room.id] = Date.now() + (hasAssistRequest ? NOTIFY_ASSIST_TIMEOUT : NOTIFY_ALL_TIMEOUT);
	} else if (hasAssistRequest && (timerEnds[room.id] - NOTIFY_ASSIST_TIMEOUT) > NOTIFY_ASSIST_TIMEOUT && unclaimedTicketTimer[room.id]) {
		// Shorten timer
		// @ts-ignore TS dosen't see the above null check
		clearTimeout(unclaimedTicketTimer[room.id]);
		unclaimedTicketTimer[room.id] = setTimeout(() => notifyUnclaimedTicket(upper, hasAssistRequest), NOTIFY_ASSIST_TIMEOUT);
		timerEnds[room.id] = Date.now() + NOTIFY_ASSIST_TIMEOUT;
	} else if (!hasUnclaimed && unclaimedTicketTimer[room.id]) {
		// @ts-ignore
		clearTimeout(unclaimedTicketTimer[room.id]);
		unclaimedTicketTimer[room.id] = null;
		timerEnds[room.id] = 0;
	}
}
/**
 * @param {boolean} upper
 * @param {boolean} hasAssistRequest
 */
function notifyUnclaimedTicket(upper, hasAssistRequest) {
	const room = /** @type {BasicChatRoom} */ (Rooms.get(upper ? 'upperstaff' : 'staff'));
	if (!room) return;
	// @ts-ignore
	clearTimeout(unclaimedTicketTimer[room.id]);
	unclaimedTicketTimer[room.id] = null;
	timerEnds[room.id] = 0;
	for (let i in room.users) {
		let user = room.users[i];
		if (user.can('mute', null, room) && !user.ignoreTickets) user.sendTo(room, `|tempnotify|helptickets|Unclaimed help tickets!|${hasAssistRequest ? 'Public Room Staff need help' : 'There are unclaimed Help tickets'}`);
	}
}

/**
 * @param {boolean} upper
 */
function notifyStaff(upper = false) {
	const room = /** @type {BasicChatRoom} */ (Rooms.get(upper ? 'upperstaff' : 'staff'));
	if (!room) return;
	let buf = ``;
	let keys = Object.keys(tickets).sort((aKey, bKey) => {
		const a = tickets[aKey];
		const b = tickets[bKey];
		if (a.open !== b.open) {
			return (a.open ? -1 : 1);
		} else if (a.open && b.open) {
			if (a.active !== b.active) {
				return (a.active ? -1 : 1);
			}
			if (!!a.claimed !== !!b.claimed) {
				return (a.claimed ? 1 : -1);
			}
			return a.created - b.created;
		}
		return 0;
	});
	let count = 0;
	let hiddenTicketUnclaimedCount = 0;
	let hiddenTicketCount = 0;
	let hasUnclaimed = false;
	let fourthTicketIndex = 0;
	let hasAssistRequest = false;
	for (const key of keys) {
		let ticket = tickets[key];
		if (!ticket.open) continue;
		if (!ticket.active) continue;
		if (!upper !== !ticket.escalated) continue;
		if (count >= 3) {
			hiddenTicketCount++;
			if (!ticket.claimed) hiddenTicketUnclaimedCount++;
			if (hiddenTicketCount === 1) {
				fourthTicketIndex = buf.length;
			} else {
				continue;
			}
		}
		const escalator = ticket.escalator ? Chat.html` (escalated by ${ticket.escalator}).` : ``;
		const creator = ticket.claimed ? Chat.html`${ticket.creator}` : Chat.html`<strong>${ticket.creator}</strong>`;
		const notifying = ticket.claimed ? `` : ` notifying`;
		const ticketRoom = Rooms.get(`help-${ticket.userid}`);
		const ticketGame = /** @type {HelpTicket} */ (ticketRoom.game);
		if (!ticket.claimed) {
			hasUnclaimed = true;
			if (ticket.type === 'Public Room Assistance Request') hasAssistRequest = true;
		}
		buf += `<a class="button${notifying}" href="/help-${ticket.userid}" ${ticketGame.getPreview()}>Help ${creator}: ${ticket.type}${escalator}</a> `;
		count++;
	}
	if (hiddenTicketCount > 1) {
		const notifying = hiddenTicketUnclaimedCount > 0 ? ` notifying` : ``;
		if (hiddenTicketUnclaimedCount > 0) hasUnclaimed = true;
		buf = buf.slice(0, fourthTicketIndex) + `<a class="button${notifying}" href="/view-help-tickets">and ${hiddenTicketCount} more Help ticket${Chat.plural(hiddenTicketCount)} (${hiddenTicketUnclaimedCount} unclaimed)</a>`;
	}
	buf = `|${hasUnclaimed ? 'uhtml' : 'uhtmlchange'}|latest-tickets|<div class="infobox" style="padding: 6px 4px">${buf}${count === 0 ? `There were open Help tickets, but they've all been closed now.` : ``}</div>`;
	room.send(buf);

	if (hasUnclaimed) {
		buf = `|tempnotify|helptickets|Unclaimed help tickets!|${hasAssistRequest ? 'Public Room Staff need help' : 'There are unclaimed Help tickets'}`;
	} else {
		buf = `|tempnotifyoff|helptickets`;
	}
	if (room.userCount) Sockets.roomBroadcast(room.id, `>view-help-tickets\n${buf}`);
	if (hasUnclaimed) {
		// only notify for people highlighting
		buf = `${buf}|${hasAssistRequest ? 'Public Room Staff need help' : 'There are unclaimed Help tickets'}`;
	}
	for (let i in room.users) {
		let user = room.users[i];
		if (user.can('mute', null, room)) user.sendTo(room, buf);
	}
	pokeUnclaimedTicketTimer(upper, hasUnclaimed, hasAssistRequest);
}

/**
 * @param {string} ip
 */
function checkIp(ip) {
	for (let t in tickets) {
		if (tickets[t].ip === ip && tickets[t].open && !Punishments.sharedIps.has(ip)) {
			return tickets[t];
		}
	}
	return false;
}

/**
 * @param {User} user
 */
function checkTicketBanned(user) {
	let ticket = ticketBans[user.userid];
	if (ticket) {
		if (ticket.expires > Date.now()) {
			return `You are banned from creating tickets${toID(ticket.banned) !== user.userid ? `, because you have the same IP as ${ticket.banned}.` : `.`}${ticket.reason ? ` Reason: ${ticket.reason}` : ``}`;
		} else {
			delete tickets[ticket.userid];
			writeTickets();
			return false;
		}
	} else {
		/** @type {BannedTicketState?} */
		let bannedTicket = null;
		const checkIp = !(Punishments.sharedIps.has(user.latestIp) && user.autoconfirmed);
		if (checkIp) {
			for (let t in ticketBans) {
				if (ticketBans[t].ip === user.latestIp) {
					bannedTicket = ticketBans[t];
					break;
				}
			}
		}
		if (!bannedTicket) return false;
		if (bannedTicket.expires > Date.now()) {
			ticket = Object.assign({}, bannedTicket);
			ticket.name = user.name;
			ticket.userid = user.userid;
			ticket.by = bannedTicket.by + ' (IP)';
			ticketBans[user.userid] = ticket;
			writeTickets();
			return `You are banned from creating tickets${toID(ticket.banned) !== user.userid ? `, because you have the same IP as ${ticket.banned}.` : `.`}${ticket.reason ? ` Reason: ${ticket.reason}` : ``}`;
		} else {
			delete ticketBans[bannedTicket.userid];
			writeTickets();
			return false;
		}
	}
}

// Prevent a desynchronization issue when hotpatching
for (const room of Rooms.rooms.values()) {
	if (!room.isHelp || !room.game) continue;
	let game = /** @type {HelpTicket} */ (room.game);
	game.ticket = tickets[game.ticket.userid];
}

/** @type {{[k: string]: string}} */
const ticketTitles = Object.assign(Object.create(null), {
	pmharassment: `PM Harassment`,
	battleharassment: `Battle Harassment`,
	inapname: `Inappropriate Username / Status Message`,
	inappokemon: `Inappropriate Pokemon Nicknames`,
	appeal: `Appeal`,
	ipappeal: `IP-Appeal`,
	appealsemi: `ISP-Appeal`,
	roomhelp: `Public Room Assistance Request`,
	other: `Other`,
});
/** @type {{[k: string]: string}} */
const ticketPages = Object.assign(Object.create(null), {
	report: `I want to report someone`,
	harassment: `Someone is harassing me`,
	inap: `Someone is using an offensive username, status message, or pokemon nickname`,
	staff: `I want to report a staff member`,

	appeal: `I want to appeal a punishment`,
	permalock: `I want to appeal my permalock`,
	lock: `I want to appeal my lock`,
	ip: `I'm locked because I have the same IP as someone I don't recognize`,
	semilock: `I can't talk in chat because of my ISP`,
	hostfilter: `I'm locked because of #hostfilter`,
	hasautoconfirmed: `Yes, I have an autoconfirmed account`,
	lacksautoconfirmed: `No, I don't have an autoconfirmed account`,
	appealother: `I want to appeal a mute/roomban/blacklist`,

	misc: `Something else`,
	password: `I lost my password`,
	roomhelp: `I need global staff to help watch a public room`,
	other: `Other`,

	confirmpmharassment: `Report harassment in a private message (PM)`,
	confirmbattleharassment: `Report harassment in a battle`,
	confirminapname: `Report an inappropriate username or status message`,
	confirminappokemon: `Report inappropriate Pok&eacute;mon nicknames`,
	confirmappeal: `Appeal your lock`,
	confirmipappeal: `Appeal IP lock`,
	confirmappealsemi: `Appeal ISP lock`,
	confirmroomhelp: `Call a Global Staff member to help`,
	confirmother: `Call a Global Staff member`,
});

/** @type {PageTable} */
const pages = {
	help: {
		request(query, user, connection) {
			if (!user.named) {
				let buf = `>view-help-request${query.length ? '-' + query.join('-') : ''}\n` +
					`|init|html\n` +
					`|title|Request Help\n` +
					`|pagehtml|<div class="pad"><h2>Request help from global staff</h2><p>Please <button name="login" class="button">Log In</button> to request help.</p></div>`;
				connection.send(buf);
				return Rooms.RETRY_AFTER_LOGIN;
			}
			this.title = 'Request Help';
			let buf = `<div class="pad"><h2>Request help from global staff</h2>`;

			let banMsg = checkTicketBanned(user);
			if (banMsg) return connection.popup(banMsg);
			let ticket = tickets[user.userid];
			let ipTicket = checkIp(user.latestIp);
			if ((ticket && ticket.open) || ipTicket) {
				if (!ticket && ipTicket) ticket = ipTicket;
				let helpRoom = Rooms.get(`help-${ticket.userid}`);
				if (!helpRoom) {
					// Should never happen
					tickets[ticket.userid].open = false;
					writeTickets();
				} else {
					if (!helpRoom.auth) {
						helpRoom.auth = {};
					}
					if (!helpRoom.auth[user.userid]) helpRoom.auth[user.userid] = '+';
					connection.popup(`You already have a Help ticket.`);
					user.joinRoom(/** @type {RoomID} */ (`help-${ticket.userid}`));
					return this.close();
				}
			}

			const isStaff = user.can('lock');
			// room / user being reported
			let meta = '';
			const targetTypeIndex = Math.max(query.indexOf('user'), query.indexOf('room'));
			if (targetTypeIndex >= 0) meta = '-' + query.splice(targetTypeIndex).join('-');
			if (!query.length) query = [''];
			for (const [i, page] of query.entries()) {
				const isLast = (i === query.length - 1);
				const isFirst = i === 1;
				if (page && page in ticketPages && !page.startsWith('confirm')) {
					let prevPageLink = query.slice(0, i).join('-');
					if (prevPageLink) prevPageLink = `-${prevPageLink}`;
					buf += `<p><a href="/view-help-request${prevPageLink}${!isFirst ? meta : ''}" target="replace"><button class="button">Back</button></a> <button class="button disabled" disabled>${ticketPages[page]}</button></p>`;
				}
				switch (page) {
				case '':
					buf += `<p><b>What's going on?</b></p>`;
					if (isStaff) {
						buf += `<p class="message-error">Global staff cannot make Help requests. This form is only for reference.</p>`;
					} else {
						buf += `<p class="message-error">Abuse of Help requests can result in a punishment.</p>`;
					}
					if (!isLast) break;
					buf += `<p><Button>report</Button></p>`;
					buf += `<p><Button>appeal</Button></p>`;
					buf += `<p><Button>misc</Button></p>`;
					break;
				case 'report':
					buf += `<p><b>What do you want to report someone for?</b></p>`;
					if (!isLast) break;
					buf += `<p><Button>harassment</Button></p>`;
					buf += `<p><Button>inap</Button></p>`;
					buf += `<p><Button>other</Button></p>`;
					break;
				case 'harassment':
					buf += `<p>If someone is harassing you in pms or a battle, click the appropriate button below and a global staff member will take a look. If you are being harassed in a chatroom, please ask a room staff member to handle it. Consider using <code>/ignore [username]</code> if it's minor instead.</p>`;
					buf += `<p>If you are reporting harassment in a battle, please save a replay of the battle.</p>`;
					if (!isLast) break;
					buf += `<p><Button>confirmpmharassment</Button> <Button>confirmbattleharassment</Button></p>`;
					break;
				case 'inap':
					buf += `<p>If a user has an inappropriate name, status message or has inappropriate Pok&eacute;mon nicknames, click the appropriate button below and a global staff member will take a look.</p>`;
					if (!isLast) break;
					buf += `<p><Button>confirminapname</Button> <Button>confirminappokemon</Button></p>`;
					break;
				case 'appeal':
					buf += `<p><b>What would you like to appeal?</b></p>`;
					if (!isLast) break;
					if (user.locked || isStaff) {
						if (user.locked === user.userid || isStaff) {
							if (user.permalocked || isStaff) {
								buf += `<p><Button>permalock</Button></p>`;
							}
							if (!user.permalocked || isStaff) {
								buf += `<p><Button>lock</Button></p>`;
							}
						}
						if (user.locked === '#hostfilter' || isStaff) {
							buf += `<p><Button>hostfilter</Button></p>`;
						}
						if ((user.locked !== user.userid && user.locked !== '#hostfilter') || isStaff) {
							buf += `<p><Button>ip</Button></p>`;
						}
					}
					if (user.semilocked || isStaff) {
						buf += `<p><Button>semilock</Button></p>`;
					}
					buf += `<p><Button>appealother</Button></p>`;
					buf += `<p><Button>other</Button></p>`;
					break;
				case 'permalock':
					buf += `<p>Please make a post in the <a href="https://www.smogon.com/forums/threads/discipline-appeal-rules.3583479/">Discipline Appeal Forums</a> to appeal a permalock.</p>`;
					break;
				case 'lock':
					buf += `<p>If you want to appeal your lock, click the button below and a global staff member will be with you shortly.</p>`;
					if (!isLast) break;
					buf += `<p><Button>confirmappeal</Button></p>`;
					break;
				case 'ip':
					buf += `<p>If you are locked under a name you don't recognize, click the button below to call a global staff member so we can check.</p>`;
					if (!isLast) break;
					buf += `<p><Button>confirmipappeal</Button></p>`;
					break;
				case 'hostfilter':
					buf += `<p>If you are locked under #hostfilter, it means you are connected to Pok&eacute;mon Showdown with a Proxy or VPN. We automatically lock these to prevent evasion of punishments. To get unlocked, you need to disable your Proxy or VPN, and use the /logout command.</p>`;
					break;
				case 'semilock':
					buf += `<p>Do you have an Autoconfirmed account? An account is autoconfirmed when they have won at least one rated battle and have been registered for one week or longer.</p>`;
					if (!isLast) break;
					buf += `<p><Button>hasautoconfirmed</Button> <Button>lacksautoconfirmed</Button></p>`;
					break;
				case 'hasautoconfirmed':
					buf += `<p>Login to your autoconfirmed account by using the /nick command, and the semilock will automatically be removed. Afterwords, you can use the /nick command to switch back to your current username without being semilocked again.</p>`;
					buf += `<p>If the semilock does not go away, you can try asking a global staff member for help. Click the button below to call a global staff member.</p>`;
					if (!isLast) break;
					buf += `<p><Button>confirmappealsemi</Button></p>`;
					break;
				case 'lacksautoconfirmed':
					buf += `<p>If you don't have an autoconfirmed account, you will need to contact a global staff member to appeal your semilock. Click the button below to call a global staff member.</p>`;
					if (!isLast) break;
					buf += `<p><Button>confirmappealsemi</Button></p>`;
					break;
				case 'appealother':
					buf += `<p>Please PM the staff member who punished you. If you don't know who punished you, ask another room staff member; they will redirect you to the correct user. If you are banned or blacklisted from the room, use <code>/roomauth [name of room]</code> to get a list of room staff members. Bold names are online.</p>`;
					break;
				case 'misc':
					buf += `<p><b>Maybe one of these options will be helpful?</b></p>`;
					if (!isLast) break;
					buf += `<p><Button>password</Button></p>`;
					if (user.trusted || isStaff) buf += `<p><Button>roomhelp</Button></p>`;
					buf += `<p><Button>other</Button></p>`;
					break;
				case 'password':
					buf += `<p>If you lost your password, click the button below to make a post in Admin Requests. We will need to clarify a few pieces of information before resetting the account. Please note that password resets are low priority and may take a while; we recommend using a new account while waiting.</p>`;
					buf += `<p><a class="button" href="https://www.smogon.com/forums/password-reset-form/">Request a password reset</a></p>`;
					break;
				case 'roomhelp':
					buf += `<p>If you are a room driver or up in a public room, and you need help watching the chat, one or more global staff members would be happy to assist you! Click the button below to call a Global Staff member.</p>`;
					buf += `<p><Button>confirmroomhelp</Button></p>`;
					break;
				case 'other':
					buf += `<p>If your issue is not handled above, click the button below to ask for a global. Please be ready to explain the situation.</p>`;
					if (!isLast) break;
					buf += `<p><Button>confirmother</Button></p>`;
					break;
				default:
					if (!page.startsWith('confirm') || !ticketTitles[page.slice(7)]) {
						buf += `<p>Malformed help request.</p>`;
						buf += `<a href="/view-help-request" target="replace"><button class="button">Back</button></a>`;
						break;
					}
					buf += `<p><b>Are you sure you want to submit a${ticketTitles[page.slice(7)].charAt(0) === 'A' ? 'n' : ''} ${ticketTitles[page.slice(7)]} report?</b></p>`;
					meta = Chat.splitFirst(meta, '-', 2).join('|'); // change the delimiter as some ticket titles include -
					buf += `<p><button class="button notifying" name="send" value="/helpticket submit ${ticketTitles[page.slice(7)]} ${meta}">Yes, Contact global staff</button> <a href="/view-help-request-${query.slice(0, i).join('-')}${meta}" target="replace"><button class="button">No, cancel</button></a></p>`;
					break;
				}
			}
			buf += '</div>';
			const curPageLink = query.length ? '-' + query.join('-') : '';
			buf = buf.replace(/<Button>([a-z]+)<\/Button>/g, (match, id) =>
				`<a class="button" href="/view-help-request${curPageLink}-${id}${meta}" target="replace">${ticketPages[id]}</a>`
			);
			return buf;
		},
		tickets(query, user, connection) {
			if (!user.named) return Rooms.RETRY_AFTER_LOGIN;
			this.title = 'Ticket List';
			if (!this.can('lock')) return;
			let buf = `<div class="pad ladder"><button class="button" name="send" value="/helpticket list" style="float:left"><i class="fa fa-refresh"></i> Refresh</button> <button class="button" name="send" value="/helpticket stats" style="float: right"><i class="fa fa-th-list"></i> Help Ticket Stats</button><br /><br />`;
			buf += `<table style="margin-left: auto; margin-right: auto"><tbody><tr><th colspan="5"><h2 style="margin: 5px auto">Help tickets</h1></th></tr>`;
			buf += `<tr><th>Status</th><th>Creator</th><th>Ticket Type</th><th>Claimed by</th><th>Action</th></tr>`;

			let keys = Object.keys(tickets).sort((aKey, bKey) => {
				const a = tickets[aKey];
				const b = tickets[bKey];
				if (a.open !== b.open) {
					return (a.open ? -1 : 1);
				}
				if (a.open) {
					if (a.active !== b.active) {
						return (a.active ? -1 : 1);
					}
					return a.created - b.created;
				}
				return b.created - a.created;
			});
			let count = 0;
			for (const key of keys) {
				if (count >= 100 && query[0] !== 'all') {
					buf += `<tr><td colspan="5">And ${keys.length - count} more tickets. <a class="button" href="/view-help-tickets-all" target="replace">View all tickets</a></td></tr>`;
					break;
				}
				const ticket = tickets[key];
				if (ticket.escalated && !user.can('declare')) continue;
				let icon = `<span style="color:gray"><i class="fa fa-check-circle-o"></i> Closed</span>`;
				if (ticket.open) {
					if (!ticket.active) {
						icon = `<span style="color:gray"><i class="fa fa-circle-o"></i> Inactive</span>`;
					} else if (ticket.claimed) {
						icon = `<span style="color:green"><i class="fa fa-circle-o"></i> Claimed</span>`;
					} else {
						icon = `<span style="color:orange"><i class="fa fa-circle-o"></i> <strong>Unclaimed</strong></span>`;
					}
				}
				buf += `<tr><td>${icon}</td>`;
				buf += Chat.html`<td>${ticket.creator}</td>`;
				buf += `<td>${ticket.type}</td>`;
				buf += Chat.html`<td>${ticket.claimed ? ticket.claimed : `-`}</td>`;
				buf += `<td>`;
				const roomid = 'help-' + ticket.userid;
				let logUrl = '';
				if (Config.modloglink) {
					logUrl = Config.modloglink(new Date(ticket.created), roomid);
				}
				let room = Rooms.get(roomid);
				if (room) {
					const ticketGame = /** @type {HelpTicket} */ (room.game);
					buf += `<a href="/${roomid}"><button class="button" ${ticketGame.getPreview()}>${!ticket.claimed && ticket.open ? 'Claim' : 'View'}</button></a> `;
				}
				if (logUrl) {
					buf += `<a href="${logUrl}"><button class="button">Log</button></a>`;
				}
				buf += '</td></tr>';
				count++;
			}

			let banKeys = Object.keys(ticketBans).sort((aKey, bKey) => {
				const a = ticketBans[aKey];
				const b = ticketBans[bKey];
				return b.created - a.created;
			});
			let hasBanHeader = false;
			count = 0;
			for (const key of banKeys) {
				const ticket = ticketBans[key];
				if (ticket.expires <= Date.now()) continue;
				if (!hasBanHeader) {
					buf += `<tr><th>Status</th><th>Username</th><th>Banned by</th><th>Expires</th><th>Logs</th></tr>`;
					hasBanHeader = true;
				}
				if (count >= 100 && query[0] !== 'all') {
					buf += `<tr><td colspan="5">And ${banKeys.length - count} more ticket bans. <a class="button" href="/view-help-tickets-all" target="replace">View all tickets</a></td></tr>`;
					break;
				}
				buf += `<tr><td><span style="color:gray"><i class="fa fa-ban"></i> Banned</td>`;
				buf += Chat.html`<td>${ticket.name}</td>`;
				buf += Chat.html`<td>${ticket.by}</td>`;
				buf += `<td>${Chat.toDurationString(ticket.expires - Date.now(), {precision: 1})}</td>`;
				buf += `<td>`;
				const roomid = 'help-' + ticket.userid;
				let logUrl = '';
				if (Config.modloglink) {
					const modlogDate = new Date(ticket.created || (ticket.banned ? ticket.expires - TICKET_BAN_DURATION : 0));
					logUrl = Config.modloglink(modlogDate, roomid);
				}
				if (logUrl) {
					buf += `<a href="${logUrl}"><button class="button">Log</button></a>`;
				}
				buf += '</td></tr>';
				count++;
			}

			buf += `</tbody></table></div>`;
			return buf;
		},
		stats(query, user, connection) {
			// view-help-stats-TABLE-YYYY-MM-COL
			if (!user.named) return Rooms.RETRY_AFTER_LOGIN;
			this.title = 'Ticket Stats';
			if (!this.can('lock')) return;

			let [table, year, month, col] = query;
			if (!['staff', 'tickets'].includes(table)) table = 'tickets';
			let monthString = `${year}-${month}`;
			let date = null;
			if (monthString.includes('undefined')) {
				// year/month not provided, use current month
				date = new Date();
				monthString = Chat.toTimestamp(date).split(' ')[0].split('-', 2).join('-');
			}
			let rawTicketStats = FS(`logs/tickets/${monthString}.tsv`).readIfExistsSync();
			if (!rawTicketStats) return `<div class="pad"><br />No ticket stats found.</div>`;

			// Calculate next/previous month for stats and validate stats exist for the month
			const prevDate = new Date(monthString);
			if (!date) date = new Date((prevDate.getMonth() === 11 ? prevDate.getFullYear() + 1 : prevDate.getFullYear()), (prevDate.getMonth() === 11 ? 0 : prevDate.getMonth() + 1));
			const nextDate = new Date((prevDate.getMonth() >= 10 ? prevDate.getFullYear() + 1 : prevDate.getFullYear()), (prevDate.getMonth() + 2 > 11 ? (prevDate.getMonth() + 2) - 12 : prevDate.getMonth() + 2));
			let prevString = Chat.toTimestamp(prevDate).split(' ')[0].split('-', 2).join('-');
			let nextString = Chat.toTimestamp(nextDate).split(' ')[0].split('-', 2).join('-');

			let buttonBar = '';
			if (FS(`logs/tickets/${prevString}.tsv`).readIfExistsSync()) {
				buttonBar += `<a class="button" href="/view-help-stats-${table}-${prevString}" target="replace" style="float: left">&lt; Previous Month</a>`;
			} else {
				buttonBar += `<a class="button disabled" style="float: left">&lt; Previous Month</a>`;
			}
			buttonBar += `<a class="button${table === 'tickets' ? ' disabled"' : `" href="/view-help-stats-tickets-${monthString}" target="replace"`}>Ticket Stats</a> <a class="button ${table === 'staff' ? ' disabled"' : `" href="/view-help-stats-staff-${monthString}" target="replace"`}>Staff Stats</a>`;
			if (FS(`logs/tickets/${nextString}.tsv`).readIfExistsSync()) {
				buttonBar += `<a class="button" href="/view-help-stats-${table}-${nextString}" target="replace" style="float: right">Next Month &gt;</a>`;
			} else {
				buttonBar += `<a class="button disabled" style="float: right">Next Month &gt;</a>`;
			}

			let buf = `<div class="pad ladder"><div style="text-align: center">${buttonBar}</div><br />`;
			buf += `<table style="margin-left: auto; margin-right: auto"><tbody><tr><th colspan="${table === 'tickets' ? 7 : 3}"><h2 style="margin: 5px auto">Help Ticket Stats - ${date.toLocaleString('en-us', {month: 'long', year: 'numeric'})}</h1></th></tr>`;
			if (table === 'tickets') {
				if (!['type', 'totaltickets', 'total', 'initwait', 'wait', 'resolution', 'result'].includes(col)) col = 'type';
				buf += `<tr><th><Button>type</Button></th><th><Button>totaltickets</Button></th><th><Button>total</Button></th><th><Button>initwait</Button></th><th><Button>wait</Button></th><th><Button>resolution</Button></th><th><Button>result</Button></th></tr>`;
			} else {
				if (!['staff', 'num', 'time'].includes(col)) col = 'num';
				buf += `<tr><th><Button>staff</Button></th><th><Button>num</Button></th><th><Button>time</Button></th></tr>`;
			}

			/** @type {{[key: string]: string}[]} */
			let ticketStats = rawTicketStats.split('\n').filter(line => line).map(line => {
				let splitLine = line.split('\t');
				return {
					type: splitLine[0],
					total: splitLine[1],
					initwait: splitLine[2],
					wait: splitLine[3],
					resolution: splitLine[4],
					result: splitLine[5],
					staff: splitLine[6],
				};
			});
			if (table === 'tickets') {
				/** @type {{[key: string]: {[key: string]: number}}} */
				let typeStats = {};
				for (let stats of ticketStats) {
					if (!typeStats[stats.type]) typeStats[stats.type] = {total: 0, initwait: 0, wait: 0, dead: 0, unresolved: 0, resolved: 0, result: 0, totaltickets: 0};
					let type = typeStats[stats.type];
					type.totaltickets++;
					type.total += parseInt(stats.total);
					type.initwait += parseInt(stats.initwait);
					type.wait += parseInt(stats.wait);
					if (['approved', 'valid', 'assisted'].includes(stats.result.toString())) type.result++;
					if (['dead', 'unresolved', 'resolved'].includes(stats.resolution.toString())) {
						type[stats.resolution.toString()]++;
					}
				}

				// Calculate averages/percentages
				for (let t in typeStats) {
					let type = typeStats[t];
					// Averages
					for (let key of ['total', 'initwait', 'wait']) {
						type[key] = Math.round(type[key] / type.totaltickets);
					}
					// Percentages
					for (let key of ['result', 'dead', 'unresolved', 'resolved']) {
						type[key] = Math.round((type[key] / type.totaltickets) * 100);
					}
				}

				let sortedStats = Object.keys(typeStats).sort((a, b) => {
					if (col === 'type') {
						// Alphabetize strings
						return a.localeCompare(b, 'en');
					} else if (col === 'resolution') {
						return (typeStats[b].resolved || 0) - (typeStats[a].resolved || 0);
					}
					return typeStats[b][col] - typeStats[a][col];
				});

				for (let type of sortedStats) {
					const resolution = `Resolved: ${typeStats[type].resolved}%<br/>Unresolved: ${typeStats[type].unresolved}%<br/>Dead: ${typeStats[type].dead}%`;
					buf += `<tr><td>${type}</td><td>${typeStats[type].totaltickets}</td><td>${Chat.toDurationString(typeStats[type].total, {hhmmss: true})}</td><td>${Chat.toDurationString(typeStats[type].initwait, {hhmmss: true}) || '-'}</td><td>${Chat.toDurationString(typeStats[type].wait, {hhmmss: true}) || '-'}</td><td>${resolution}</td><td>${typeStats[type].result}%</td></tr>`;
				}
			} else {
				/** @type {{[key: string]: {[key: string]: number}}} */
				let staffStats = {};
				for (let stats of ticketStats) {
					let staff = (typeof stats.staff === 'string' ? stats.staff.split(',') : []);
					for (let s = 0; s < staff.length; s++) {
						if (!staff[s]) continue;
						if (!staffStats[staff[s]]) staffStats[staff[s]] = {num: 0, time: 0};
						staffStats[staff[s]].num++;
						staffStats[staff[s]].time += (parseInt(stats.total) - parseInt(stats.initwait));
					}
				}
				for (let staff in staffStats) {
					staffStats[staff].time = Math.round(staffStats[staff].time / staffStats[staff].num);
				}
				let sortedStaff = Object.keys(staffStats).sort((a, b) => {
					if (col === 'staff') {
						// Alphabetize strings
						return a.localeCompare(b, 'en');
					}
					return staffStats[b][col] - staffStats[a][col];
				});
				for (let staff of sortedStaff) {
					buf += `<tr><td>${staff}</td><td>${staffStats[staff].num}</td><td>${Chat.toDurationString(staffStats[staff].time, {precision: 1})}</td></tr>`;
				}
			}
			buf += `</tbody></table></div>`;
			/** @type {{[id: string]: string}} */
			const headerTitles = {
				type: 'Type',
				totaltickets: 'Total Tickets',
				total: 'Average Total Time',
				initwait: 'Average Initial Wait',
				wait: 'Average Total Wait',
				resolution: 'Resolutions',
				result: 'Positive Result',
				staff: 'Staff ID',
				num: 'Number of Tickets',
				time: 'Average Time Per Ticket',
			};
			buf = buf.replace(/<Button>([a-z]+)<\/Button>/g, (match, id) => {
				if (col === id) return headerTitles[id];
				return `<a class="button" href="/view-help-stats-${table}-${monthString}-${id}" target="replace">${headerTitles[id]}</a>`;
			});
			return buf;
		},
	},
};
exports.pages = pages;

/** @type {ChatCommands} */
let commands = {
	'!report': true,
	report(target, room, user) {
		if (!this.runBroadcast()) return;
		const meta = this.pmTarget ? `-user-${this.pmTarget.userid}` : this.room ? `-room-${this.room.id}` : '';
		if (this.broadcasting) {
			if (room && room.battle) return this.errorReply(`This command cannot be broadcast in battles.`);
			return this.sendReplyBox(`<button name="joinRoom" value="view-help-request--report${meta}" class="button"><strong>Report someone</strong></button>`);
		}

		return this.parse(`/join view-help-request--report${meta}`);
	},

	'!appeal': true,
	appeal(target, room, user) {
		if (!this.runBroadcast()) return;
		const meta = this.pmTarget ? `-user-${this.pmTarget.userid}` : this.room ? `-room-${this.room.id}` : '';
		if (this.broadcasting) {
			if (room && room.battle) return this.errorReply(`This command cannot be broadcast in battles.`);
			return this.sendReplyBox(`<button name="joinRoom" value="view-help-request--appeal${meta}" class="button"><strong>Appeal a punishment</strong></button>`);
		}

		return this.parse(`/join view-help-request--appeal${meta}`);
	},

	requesthelp: 'helpticket',
	helprequest: 'helpticket',
	ht: 'helpticket',
	helpticket: {
		'!create': true,
		'': 'create',
		create(target, room, user) {
			if (!this.runBroadcast()) return;
			const meta = this.pmTarget ? `-user-${this.pmTarget.userid}` : this.room ? `-room-${this.room.id}` : '';
			if (this.broadcasting) {
				return this.sendReplyBox(`<button name="joinRoom" value="view-help-request${meta}" class="button"><strong>Request help</strong></button>`);
			}
			if (user.can('lock')) return this.parse('/join view-help-request'); // Globals automatically get the form for reference.
			if (!user.named) return this.errorReply(`You need to choose a username before doing this.`);
			return this.parse(`/join view-help-request${meta}`);
		},
		createhelp: [`/helpticket create - Creates a new ticket requesting help from global staff.`],

		'!submit': true,
		submit(target, room, user, connection) {
			if (user.can('lock') && !user.can('bypassall')) return this.popupReply(`Global staff can't make tickets. They can only use the form for reference.`);
			if (!user.named) return this.popupReply(`You need to choose a username before doing this.`);
			let banMsg = checkTicketBanned(user);
			if (banMsg) return this.popupReply(banMsg);
			let ticket = tickets[user.userid];
			let ipTicket = checkIp(user.latestIp);
			if ((ticket && ticket.open) || ipTicket) {
				if (!ticket && ipTicket) ticket = ipTicket;
				let helpRoom = Rooms.get(`help-${ticket.userid}`);
				if (!helpRoom) {
					// Should never happen
					tickets[ticket.userid].open = false;
					writeTickets();
				} else {
					if (!helpRoom.auth) {
						helpRoom.auth = {};
					}
					if (!helpRoom.auth[user.userid]) helpRoom.auth[user.userid] = '+';
					this.parse(`/join help-${ticket.userid}`);
					return this.popupReply(`You already have an open ticket; please wait for global staff to respond.`);
				}
			}
			if (Monitor.countTickets(user.latestIp)) return this.popupReply(`Due to high load, you are limited to creating ${Punishments.sharedIps.has(user.latestIp) ? `50` : `5`} tickets every hour.`);
			let [ticketType, reportTargetType, reportTarget] = Chat.splitFirst(target, '|', 2).map(s => s.trim());
			reportTarget = Chat.escapeHTML(reportTarget);
			if (!Object.values(ticketTitles).includes(ticketType)) return this.parse('/helpticket');
			/** @type {{[k: string]: string}} */
			const contexts = {
				'PM Harassment': `Hi! Who was harassing you in private messages?`,
				'Battle Harassment': `Hi! Who was harassing you, and in which battle did it happen? Please post a link to the battle or a replay of the battle.`,
				'Inappropriate Username / Status Message': `Hi! Tell us the username that is inappropriate, or tell us which user has an inappropriate status message.`,
				'Inappropriate Pokemon Nicknames': `Hi! Which user has pokemon with inappropriate nicknames, and in which battle? Please post a link to the battle or a replay of the battle.`,
				'Appeal': `Hi! Can you please explain why you feel your punishment is undeserved?`,
				'Public Room Assistance Request': `Hi! Which room(s) do you need us to help you watch?`,
				'Other': `Hi! What seems to be the problem? Tell us about any people involved, and if this happened in a specific place on the site.`,
			};
			/** @type {{[k: string]: string}} */
			const staffContexts = {
				'IP-Appeal': `<p><strong>${user.name}'s IP Addresses</strong>: ${Object.keys(user.ips).map(ip => `<a href="https://whatismyipaddress.com/ip/${ip}" target="_blank">${ip}</a>`).join(', ')}</p>`,
			};
			ticket = {
				creator: user.name,
				userid: user.userid,
				open: true,
				active: !contexts[ticketType],
				type: ticketType,
				created: Date.now(),
				claimed: null,
				escalated: false,
				ip: user.latestIp,
			};
			let closeButtons = ``;
			switch (ticket.type) {
			case 'Appeal':
			case 'IP-Appeal':
			case 'ISP-Appeal':
				closeButtons = `<button class="button" style="margin: 5px 0" name="send" value="/helpticket close ${user.userid}">Close Ticket as Appeal Granted</button> <button class="button" style="margin: 5px 0" name="send" value="/helpticket close ${user.userid}, false">Close Ticket as Appeal Denied</button>`;
				break;
			case 'PM Harassment':
			case 'Battle Harassment':
			case 'Inappropriate Pokemon Nicknames':
			case 'Inappropriate Username / Status Message':
				closeButtons = `<button class="button" style="margin: 5px 0" name="send" value="/helpticket close ${user.userid}">Close Ticket as Valid Report</button> <button class="button" style="margin: 5px 0" name="send" value="/helpticket close ${user.userid}, false">Close Ticket as Invalid Report</button>`;
				break;
			case 'Public Room Assistance Request':
			case 'Other':
			default:
				closeButtons = `<button class="button" style="margin: 5px 0" name="send" value="/helpticket close ${user.userid}">Close Ticket as Assisted</button> <button class="button" style="margin: 5px 0" name="send" value="/helpticket close ${user.userid}, false">Close Ticket as Unable to Assist</button>`;
			}
			const introMessage = Chat.html`<h2 style="margin-top:0">Help Ticket - ${user.name}</h2><p><b>Issue</b>: ${ticket.type}<br />A Global Staff member will be with you shortly.</p>`;
			const staffMessage = `<p>${closeButtons} <details><summary class="button">More Options</summary><button class="button" name="send" value="/helpticket escalate ${user.userid}">Escalate</button> <button class="button" name="send" value="/helpticket escalate ${user.userid}, upperstaff">Escalate to Upper Staff</button> <button class="button" name="send" value="/helpticket ban ${user.userid}"><small>Ticketban</small></button></details></p>`;
			const staffHint = staffContexts[ticketType] || '';
			const reportTargetInfo =
				reportTargetType === 'room' ? `Reported in room: <a href="/${reportTarget}">${reportTarget}</a>` :
					reportTargetType === 'user' ? `Reported user: <strong class="username">${reportTarget}</strong>` : '';
			let helpRoom = /** @type {ChatRoom?} */ (Rooms.get(`help-${user.userid}`));
			if (!helpRoom) {
				helpRoom = Rooms.createChatRoom(/** @type {RoomID} */ (`help-${user.userid}`), `[H] ${user.name}`, {
					isPersonal: true,
					isHelp: 'open',
					isPrivate: 'hidden',
					modjoin: '%',
					auth: {[user.userid]: '+'},
					introMessage: introMessage,
					staffMessage: staffMessage + staffHint + reportTargetInfo,
				});
				helpRoom.game = new HelpTicket(helpRoom, ticket);
			} else {
				helpRoom.isHelp = 'open';
				if (helpRoom.expireTimer) clearTimeout(helpRoom.expireTimer);
				helpRoom.introMessage = introMessage;
				helpRoom.staffMessage = staffMessage + staffHint;
				if (helpRoom.game) helpRoom.game.destroy();
				helpRoom.game = new HelpTicket(helpRoom, ticket);
			}
			const ticketGame = /** @type {HelpTicket} */ (helpRoom.game);
			ticketGame.modnote(user, `${user.name} opened a new ticket. Issue: ${ticket.type}`);
			this.parse(`/join help-${user.userid}`);
			if (!(user.userid in ticketGame.playerTable)) {
				// User was already in the room, manually add them to the "game" so they get a popup if they try to leave
				ticketGame.addPlayer(user);
			}
			if (contexts[ticket.type]) {
				helpRoom.add(`|c|~Staff|${contexts[ticket.type]}`);
				helpRoom.update();
			}
			tickets[user.userid] = ticket;
			writeTickets();
			notifyStaff(false);
			connection.send(`>view-help-request\n|deinit`);
		},

		escalate(target, room, user, connection) {
			if (!this.can('lock')) return;
			target = toID(this.splitTarget(target, true));
			if (!this.targetUsername) return this.parse(`/help helpticket escalate`);
			let ticket = tickets[toID(this.inputUsername)];
			if (!ticket || !ticket.open) return this.errorReply(`${this.targetUsername} does not have an open ticket.`);
			if (ticket.escalated && !user.can('declare')) return this.errorReply(`/helpticket escalate - Access denied for escalating upper staff tickets.`);
			if (target === 'upperstaff' && ticket.escalated) return this.errorReply(`${ticket.creator}'s ticket is already escalated.`);
			let helpRoom = Rooms.get('help-' + ticket.userid);
			if (!helpRoom) return this.errorReply(`${ticket.creator}'s help room is expired and cannot be escalated.`);
			const ticketGame = /** @type {HelpTicket} */ (helpRoom.game);
			ticketGame.escalate((toID(target) === 'upperstaff'), user);
			return this.sendReply(`${ticket.creator}'s ticket was escalated.`);
		},
		escalatehelp: [`/helpticket escalate [user], (upperstaff) - Escalate a ticket. If upperstaff is included, escalate the ticket to upper staff. Requires: % @ & ~`],

		'!list': true,
		list(target, room, user) {
			if (!this.can('lock')) return;
			this.parse('/join view-help-tickets');
		},
		listhelp: [`/helpticket list - Lists all tickets. Requires: % @ & ~`],

		'!stats': true,
		stats(target, room, user) {
			if (!this.can('lock')) return;
			this.parse('/join view-help-stats');
		},
		statshelp: [`/helpticket stats - List the stats for help tickets. Requires: % @ & ~`],

		'!close': true,
		close(target, room, user) {
			if (!target) return this.parse(`/help helpticket close`);
			let result = !(this.splitTarget(target) === 'false');
			let ticket = tickets[toID(this.inputUsername)];
			if (!ticket || !ticket.open || (ticket.userid !== user.userid && !user.can('lock'))) return this.errorReply(`${target} does not have an open ticket.`);
			if (ticket.escalated && ticket.userid !== user.userid && !user.can('declare')) return this.errorReply(`/helpticket close - Access denied for closing upper staff tickets.`);
			const helpRoom = /** @type {ChatRoom?} */ (Rooms.get(`help-${ticket.userid}`));
			if (helpRoom) {
				const ticketGame = /** @type {HelpTicket} */ (helpRoom.game);
				if (ticket.userid === user.userid && !user.isStaff) {
					result = !!(ticketGame.firstClaimTime);
				}
				ticketGame.close(user, result);
			} else {
				ticket.open = false;
				notifyStaff(ticket.escalated);
				writeTickets();
			}
			ticket.claimed = user.name;
			this.sendReply(`You closed ${ticket.creator}'s ticket.`);
		},
		closehelp: [`/helpticket close [user] - Closes an open ticket. Requires: % @ & ~`],

		ban(target, room, user) {
			if (!target) return this.parse('/help helpticket ban');
			target = this.splitTarget(target, true);
			let targetUser = this.targetUser;
			if (!this.can('lock', targetUser)) return;

			let ticket = tickets[toID(this.inputUsername)];
			let ticketBan = ticketBans[toID(this.inputUsername)];
			if (!targetUser && !Punishments.search(toID(this.targetUsername)).length && !ticket && !ticketBan) {
				return this.errorReply(`User '${this.targetUsername}' not found.`);
			}
			if (target.length > 300) {
				return this.errorReply(`The reason is too long. It cannot exceed 300 characters.`);
			}

			let name, userid;

			if (targetUser) {
				name = targetUser.getLastName();
				userid = targetUser.getLastId();
				if (ticketBan && ticketBan.expires > Date.now()) return this.privateModAction(`(${name} would be ticket banned by ${user.name} but was already ticket banned.)`);
				if (targetUser.trusted) Monitor.log(`[CrisisMonitor] Trusted user ${targetUser.name}${(targetUser.trusted !== targetUser.userid ? ` (${targetUser.trusted})` : ``)} was ticket banned by ${user.name}, and should probably be demoted.`);
			} else {
				name = this.targetUsername;
				userid = toID(this.targetUsername);
				if (ticketBan && ticketBan.expires > Date.now()) return this.privateModAction(`(${name} would be ticket banned by ${user.name} but was already ticket banned.)`);
			}

			if (targetUser) {
				targetUser.popup(`|modal|${user.name} has banned you from creating help tickets.${(target ? `\n\nReason: ${target}` : ``)}\n\nYour ban will expire in a few days.`);
			}

			this.addModAction(`${name} was ticket banned by ${user.name}.${target ? ` (${target})` : ``}`);

			let affected = /** @type {any[]} */ ([]);
			let punishment = /** @type {BannedTicketState} */ ({
				banned: name,
				name: name,
				userid: toID(name),
				by: user.name,
				created: Date.now(),
				expires: Date.now() + TICKET_BAN_DURATION,
				reason: target,
				ip: (targetUser ? targetUser.latestIp : ticket ? ticket.ip : ticketBan.ip),
			});

			if (targetUser) {
				affected.push(targetUser);
				affected.concat(targetUser.getAltUsers(false, true));
			} else {
				let foundKeys = Punishments.search(userid).map(([key]) => key);
				let userids = new Set([userid]);
				let ips = new Set();
				for (let key of foundKeys) {
					if (key.includes('.')) {
						ips.add(key);
					} else {
						userids.add(key);
					}
				}
				affected = Users.findUsers(/** @type {ID[]} */([...userids]), [...ips], {includeTrusted: true, forPunishment: true});
				affected.unshift(userid);
			}

			let acAccount = (targetUser && targetUser.autoconfirmed !== userid && targetUser.autoconfirmed);
			let displayMessage = '';
			if (affected.length > 1) {
				displayMessage = `(${name}'s ${acAccount ? ` ac account: ${acAccount}, ` : ""}ticket banned alts: ${affected.slice(1).map(user => user.getLastName()).join(", ")})`;
				this.privateModAction(displayMessage);
			} else if (acAccount) {
				displayMessage = `(${name}'s ac account: ${acAccount})`;
				this.privateModAction(displayMessage);
			}

			for (let user of affected) {
				let userid = (typeof user !== 'string' ? user.getLastId() : toID(user));
				let targetTicket = tickets[userid];
				if (targetTicket && targetTicket.open) targetTicket.open = false;
				const helpRoom = Rooms.get(`help-${userid}`);
				if (helpRoom) {
					const ticketGame = /** @type {HelpTicket} */ (helpRoom.game);
					ticketGame.writeStats('ticketban');
					helpRoom.destroy();
				}
				ticketBans[userid] = punishment;
			}
			writeTickets();
			notifyStaff();
			notifyStaff(true);

			this.globalModlog(`TICKETBAN`, targetUser || userid, ` by ${user.name}${target}`);
			return true;
		},
		banhelp: [`/helpticket ban [user], (reason) - Bans a user from creating tickets for 2 days. Requires: % @ & ~`],

		unban(target, room, user) {
			if (!target) return this.parse('/help helpticket unban');

			if (!this.can('lock')) return;
			let targetUser = Users.get(target, true);
			let ticket = ticketBans[toID(target)];
			if (!ticket || !ticket.banned) return this.errorReply(`${targetUser ? targetUser.name : target} is not ticket banned.`);
			if (ticket.expires <= Date.now()) {
				delete tickets[ticket.userid];
				writeTickets();
				return this.errorReply(`${targetUser ? targetUser.name : target}'s ticket ban is already expired.`);
			}

			let affected = [];
			for (let t in ticketBans) {
				if (toID(ticketBans[t].banned) === toID(ticket.banned) && ticketBans[t].userid !== ticket.userid) {
					affected.push(ticketBans[t].name);
					delete ticketBans[t];
				}
			}
			affected.unshift(ticket.name);
			delete ticketBans[ticket.userid];
			writeTickets();

			this.addModAction(`${affected.join(', ')} ${Chat.plural(affected.length, "were", "was")} ticket unbanned by ${user.name}.`);
			this.globalModlog("UNTICKETBAN", target, `by ${user.userid}`);
			if (targetUser) targetUser.popup(`${user.name} has ticket unbanned you.`);
		},
		unbanhelp: [`/helpticket unban [user] - Ticket unbans a user. Requires: % @ & ~`],

		ignore(target, room, user) {
			if (!this.can('lock')) return;
			if (user.ignoreTickets) return this.errorReply(`You are already ignoring help ticket notifications. Use /helpticket unignore to receive notifications again.`);
			user.ignoreTickets = true;
			user.update('ignoreTickets');
			this.sendReply(`You are now ignoring help ticket notifications.`);
		},
		ignorehelp: [`/helpticket ignore - Ignore notifications for unclaimed help tickets. Requires: % @ & ~`],

		unignore(target, room, user) {
			if (!this.can('lock')) return;
			if (!user.ignoreTickets) return this.errorReply(`You are not ignoring help ticket notifications. Use /helpticket ignore to stop receiving notifications.`);
			user.ignoreTickets = false;
			user.update('ignoreTickets');
			this.sendReply(`You will now receive help ticket notifications.`);
		},
		unignorehelp: [`/helpticket unignore - Stop ignoring notifications for help tickets. Requires: % @ & ~`],

		delete(target, room, user) {
			// This is a utility only to be used if something goes wrong
			if (!this.can('declare')) return;
			if (!target) return this.parse(`/help helpticket delete`);
			let ticket = tickets[toID(target)];
			if (!ticket) return this.errorReply(`${target} does not have a ticket.`);
			let targetRoom = /** @type {ChatRoom} */ (Rooms.get(`help-${ticket.userid}`));
			if (targetRoom) {
				// @ts-ignore
				targetRoom.game.deleteTicket(user);
			} else {
				delete tickets[ticket.userid];
				writeTickets();
				notifyStaff(ticket.escalated);
			}
			this.sendReply(`You deleted ${target}'s ticket.`);
		},
		deletehelp: [`/helpticket delete [user] - Deletes a users ticket. Requires: & ~`],

	},
	helptickethelp: [
		`/helpticket create - Creates a new ticket, requesting help from global staff.`,
		`/helpticket list - Lists all tickets. Requires: % @ & ~`,
		`/helpticket escalate [user], (upperstaff) - Escalates a ticket. If upperstaff is included, the ticket is escalated to upper staff. Requires: % @ & ~`,
		`/helpticket close [user] - Closes an open ticket. Requires: % @ & ~`,
		`/helpticket ban [user], (reason) - Bans a user from creating tickets for 2 days. Requires: % @ & ~`,
		`/helpticket unban [user] - Ticket unbans a user. Requires: % @ & ~`,
		`/helpticket ignore - Ignore notifications for unclaimed help tickets. Requires: % @ & ~`,
		`/helpticket unignore - Stop ignoring notifications for help tickets. Requires: % @ & ~`,
		`/helpticket delete [user] - Deletes a user's ticket. Requires: & ~`,
	],
};
exports.commands = commands;
