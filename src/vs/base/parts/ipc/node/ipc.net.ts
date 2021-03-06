/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { Socket, Server as NetServer, createConnection, createServer } from 'net';
import { Duplex } from 'stream';
import { TPromise } from 'vs/base/common/winjs.base';
import Event, { Emitter, once, mapEvent } from 'vs/base/common/event';
import { fromEventEmitter } from 'vs/base/node/event';
import { IMessagePassingProtocol, ClientConnectionEvent, IPCServer, IPCClient } from 'vs/base/parts/ipc/common/ipc';
import { join } from 'path';
import { tmpdir } from 'os';

export function generateRandomPipeName(): string {
	let randomName = 'vscode-' + Math.floor(Math.random() * 10000).toString(16);
	if (process.platform === 'win32') {
		return '\\\\.\\pipe\\' + randomName + '-sock';
	} else {
		// Mac/Unix: use socket file
		return join(tmpdir(), randomName + '.sock');
	}
}

export class Protocol implements IMessagePassingProtocol {

	private static _headerLen = 17;

	private _onMessage = new Emitter<any>();

	readonly onMessage: Event<any> = this._onMessage.event;

	constructor(private stream: Duplex) {

		let chunks = [];
		let totalLength = 0;

		const state = {
			readHead: true,
			bodyIsJson: false,
			bodyLen: -1,
		};

		stream.on('data', (data: Buffer) => {

			chunks.push(data);
			totalLength += data.length;

			while (totalLength > 0) {

				if (state.readHead) {
					// expecting header -> read 17bytes for header
					// information: `bodyIsJson` and `bodyLen`
					if (totalLength >= Protocol._headerLen) {
						const all = Buffer.concat(chunks);

						state.bodyIsJson = all.readInt8(0) === 1;
						state.bodyLen = all.readInt32BE(1);
						state.readHead = false;

						const rest = all.slice(Protocol._headerLen);
						totalLength = rest.length;
						chunks = [rest];

					} else {
						break;
					}
				}

				if (!state.readHead) {
					// expecting body -> read bodyLen-bytes for
					// the actual message or wait for more data
					if (totalLength >= state.bodyLen) {

						const all = Buffer.concat(chunks);
						let message = all.toString('utf8', 0, state.bodyLen);
						if (state.bodyIsJson) {
							message = JSON.parse(message);
						}
						this._onMessage.fire(message);

						const rest = all.slice(state.bodyLen);
						totalLength = rest.length;
						chunks = [rest];

						state.bodyIsJson = false;
						state.bodyLen = -1;
						state.readHead = true;

					} else {
						break;
					}
				}
			}
		});
	}

	public send(message: any): void {

		// [bodyIsJson|bodyLen|message]
		// |^header^^^^^^^^^^^|^data^^]

		const header = Buffer.alloc(Protocol._headerLen);

		// ensure string
		if (typeof message !== 'string') {
			message = JSON.stringify(message);
			header.writeInt8(1, 0);
		}
		const data = Buffer.from(message);
		header.writeInt32BE(data.length, 1);

		try {
			this.stream.write(header);
			this.stream.write(data);
		} catch (e) {
			// noop
		}
	}
}

export class Server extends IPCServer {

	private static toClientConnectionEvent(server: NetServer): Event<ClientConnectionEvent> {
		const onConnection = fromEventEmitter<Socket>(server, 'connection');

		return mapEvent(onConnection, socket => ({
			protocol: new Protocol(socket),
			onDidClientDisconnect: once(fromEventEmitter<void>(socket, 'close'))
		}));
	}

	constructor(private server: NetServer) {
		super(Server.toClientConnectionEvent(server));
	}

	dispose(): void {
		super.dispose();
		this.server.close();
		this.server = null;
	}
}

export class Client extends IPCClient {

	private _onClose = new Emitter<void>();
	get onClose(): Event<void> { return this._onClose.event; }

	constructor(private socket: Socket, id: string) {
		super(new Protocol(socket), id);
		socket.once('close', () => this._onClose.fire());
	}

	dispose(): void {
		super.dispose();
		this.socket.end();
		this.socket = null;
	}
}

export function serve(port: number): TPromise<Server>;
export function serve(namedPipe: string): TPromise<Server>;
export function serve(hook: any): TPromise<Server> {
	return new TPromise<Server>((c, e) => {
		const server = createServer();

		server.on('error', e);
		server.listen(hook, () => {
			server.removeListener('error', e);
			c(new Server(server));
		});
	});
}

export function connect(port: number, clientId: string): TPromise<Client>;
export function connect(namedPipe: string, clientId: string): TPromise<Client>;
export function connect(hook: any, clientId: string): TPromise<Client> {
	return new TPromise<Client>((c, e) => {
		const socket = createConnection(hook, () => {
			socket.removeListener('error', e);
			c(new Client(socket, clientId));
		});

		socket.once('error', e);
	});
}
