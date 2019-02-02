import {
    Browser,
    ConnectionState,
    FileMode,
    IAttachMessage,
    IChaincode,
    IChaincodeModule,
    IChannel,
    IDistributedObjectServices,
    IDocumentStorageService,
    IEnvelope,
    IGenericBlob,
    IHelpMessage,
    IObjectAttributes,
    IObjectMessage,
    IObjectStorageService,
    IPlatform,
    IQuorum,
    IRuntime,
    ISequencedDocumentMessage,
    ISequencedObjectMessage,
    ISnapshotTree,
    ITreeEntry,
    MessageType,
    TreeEntry,
} from "@prague/runtime-definitions";
import { Deferred, gitHashFile } from "@prague/utils";
import * as assert from "assert";
import { EventEmitter } from "events";
import { BlobManager } from "./blobManager";
import { ChannelDeltaConnection } from "./channelDeltaConnection";
import { ChannelStorageService } from "./channelStorageService";
import { debug } from "./debug";
import { DeltaManager } from "./deltaManager";
import { LeaderElector } from "./leaderElection";
import { LocalChannelStorageService } from "./localChannelStorageService";
import { analyzeTasks, getLeaderCandidate } from "./taskAnalyzer";
import { readAndParse } from "./utils";

export interface IChannelState {
    object: IChannel;
    storage: IObjectStorageService;
    connection: ChannelDeltaConnection;
}

interface IObjectServices {
    deltaConnection: ChannelDeltaConnection;
    objectStorage: IObjectStorageService;
}

export class Runtime extends EventEmitter implements IRuntime {
    public static async LoadFromSnapshot(
        tenantId: string,
        id: string,
        platform: IPlatform,
        parentBranch: string,
        existing: boolean,
        options: any,
        clientId: string,
        blobManager: BlobManager,
        pkg: string,
        chaincode: IChaincode,
        tardisMessages: Map<string, ISequencedDocumentMessage[]>,
        deltaManager: DeltaManager,
        quorum: IQuorum,
        storage: IDocumentStorageService,
        connectionState: ConnectionState,
        channels: { [path: string]: ISnapshotTree },
        branch: string,
        minimumSequenceNumber: number,
        submitFn: (type: MessageType, contents: any) => void,
        snapshotFn: (message: string) => Promise<void>,
        closeFn: () => void) {

        const runtime = new Runtime(
            tenantId,
            id,
            parentBranch,
            existing,
            options,
            clientId,
            blobManager,
            deltaManager,
            quorum,
            pkg,
            chaincode,
            storage,
            connectionState,
            submitFn,
            snapshotFn,
            closeFn);

        if (channels) {
            Object.keys(channels).forEach((path) => {
                // Reserve space for the channel
                runtime.reserve(path);
            });

            /* tslint:disable:promise-function-async */
            const loadSnapshotsP = Object.keys(channels).map((path) => {
                return runtime.loadSnapshotChannel(
                    runtime,
                    path,
                    channels[path],
                    storage,
                    tardisMessages.has(path) ? tardisMessages.get(path) : [],
                    branch,
                    minimumSequenceNumber);
            });

            await Promise.all(loadSnapshotsP);
        }

        // Start the runtime
        await runtime.start(platform);

        return runtime;
    }

    public get connected(): boolean {
        return this.connectionState === ConnectionState.Connected;
    }

    // Interface used to access the runtime code
    public get platform(): IPlatform {
        return this._platform;
    }

    private channels = new Map<string, IChannelState>();
    private channelsDeferred = new Map<string, Deferred<IChannel>>();
    private closed = false;
    private pendingAttach = new Map<string, IAttachMessage>();

    // tslint:disable-next-line:variable-name
    private _platform: IPlatform;
    // tslint:enable-next-line:variable-name

    private tasks: string[] = [];
    private leaderElector: LeaderElector;

    // back-compat: version decides between loading document and chaincode.
    private version: string;

    private constructor(
        public readonly tenantId: string,
        public readonly id: string,
        public readonly parentBranch: string,
        public existing: boolean,
        public readonly options: any,
        public clientId: string,
        private blobManager: BlobManager,
        public readonly deltaManager: DeltaManager,
        private quorum: IQuorum,
        public readonly pkg: string,
        public readonly chaincode: IChaincode,
        private storageService: IDocumentStorageService,
        private connectionState: ConnectionState,
        private submitFn: (type: MessageType, contents: any) => void,
        private snapshotFn: (message: string) => Promise<void>,
        private closeFn: () => void) {
        super();
    }

    public getChannel(id: string): Promise<IChannel> {
        this.verifyNotClosed();

        // TODO we don't assume any channels (even root) in the runtime. If you request a channel that doesn't exist
        // we will never resolve the promise. May want a flag to getChannel that doesn't wait for the promise if
        // it doesn't exist
        if (!this.channelsDeferred.has(id)) {
            this.channelsDeferred.set(id, new Deferred<IChannel>());
        }

        return this.channelsDeferred.get(id).promise;
    }

    public createChannel(id: string, type: string): IChannel {
        this.verifyNotClosed();

        const extension = this.chaincode.getModule(type) as IChaincodeModule;
        const channel = extension.create(this, id);
        this.channels.set(id, { object: channel, connection: null, storage: null });

        if (this.channelsDeferred.has(id)) {
            this.channelsDeferred.get(id).resolve(channel);
        } else {
            const deferred = new Deferred<IChannel>();
            deferred.resolve(channel);
            this.channelsDeferred.set(id, deferred);
        }

        return channel;
    }

    public attachChannel(channel: IChannel): IDistributedObjectServices {
        this.verifyNotClosed();

        // Get the object snapshot and include it in the initial attach
        const snapshot = channel.snapshot();

        const message: IAttachMessage = {
            id: channel.id,
            snapshot,
            type: channel.type,
        };
        this.pendingAttach.set(channel.id, message);
        this.submit(MessageType.Attach, message);

        // Store a reference to the object in our list of objects and then get the services
        // used to attach it to the stream
        const services = this.getObjectServices(channel.id, null, this.storageService);

        const entry = this.channels.get(channel.id);
        assert.equal(entry.object, channel);
        entry.connection = services.deltaConnection;
        entry.storage = services.objectStorage;

        return services;
    }

    public async ready(): Promise<void> {
        this.verifyNotClosed();

        await Promise.all(Array.from(this.channels.values()).map((value) => value.object.ready()));
    }

    public async start(platform: IPlatform): Promise<void> {
        this.verifyNotClosed();

        // tslint:disable-next-line:no-floating-promises
        this._platform = await this.chaincode.run(this, platform);
    }

    public changeConnectionState(value: ConnectionState, clientId: string) {
        this.verifyNotClosed();

        if (value === this.connectionState) {
            return;
        }

        this.connectionState = value;
        this.clientId = clientId;

        // Resend all pending attach messages prior to notifying clients
        if (value === ConnectionState.Connected) {
            for (const [, message] of this.pendingAttach) {
                this.submit(MessageType.Attach, message);
            }
            this.emit("connected", clientId);
        }

        for (const [, object] of this.channels) {
            if (object.connection) {
                object.connection.setConnectionState(value);
            }
        }
    }

    public prepare(message: ISequencedDocumentMessage, local: boolean) {
        this.verifyNotClosed();

        const envelope = message.contents as IEnvelope;
        const objectDetails = this.channels.get(envelope.address);
        assert(objectDetails);

        return objectDetails.connection.prepare(message, local);
    }

    public process(message: ISequencedDocumentMessage, local: boolean, context: any): IChannel {
        this.verifyNotClosed();

        const envelope = message.contents as IEnvelope;
        const objectDetails = this.channels.get(envelope.address);
        assert(objectDetails);

        /* tslint:disable:no-unsafe-any */
        objectDetails.connection.process(message, local, context);

        return objectDetails.object;
    }

    public processAttach(message: ISequencedDocumentMessage, local: boolean, context: IChannelState): IChannel {
        this.verifyNotClosed();

        const attachMessage = message.contents as IAttachMessage;

        // If a non-local operation then go and create the object - otherwise mark it as officially attached.
        if (local) {
            assert(this.pendingAttach.has(attachMessage.id));
            this.pendingAttach.delete(attachMessage.id);

            // Document sequence number references <= message.sequenceNumber should map to the
            // object's 0 sequence number. We cap to the MSN to keep a tighter window and because
            // no references should be below it.
            this.channels.get(attachMessage.id).connection.setBaseMapping(
                0,
                message.minimumSequenceNumber);
        } else {
            const channelState = context as IChannelState;
            this.channels.set(channelState.object.id, channelState);
            if (this.channelsDeferred.has(channelState.object.id)) {
                this.channelsDeferred.get(channelState.object.id).resolve(channelState.object);
            } else {
                const deferred = new Deferred<IChannel>();
                deferred.resolve(channelState.object);
                this.channelsDeferred.set(channelState.object.id, deferred);
            }
        }

        return this.channels.get(attachMessage.id).object;
    }

    public async prepareAttach(message: ISequencedDocumentMessage, local: boolean): Promise<IChannelState> {
        this.verifyNotClosed();

        if (local) {
            return;
        }

        const attachMessage = message.contents as IAttachMessage;

        // create storage service that wraps the attach data
        const localStorage = new LocalChannelStorageService(attachMessage.snapshot);
        const connection = new ChannelDeltaConnection(
            attachMessage.id,
            this.connectionState,
            (submitMessage) => {
                const submitEnvelope: IEnvelope = { address: attachMessage.id, contents: submitMessage };
                this.submit(MessageType.Operation, submitEnvelope);
            });

        // Document sequence number references <= message.sequenceNumber should map to the object's 0
        // sequence number. We cap to the MSN to keep a tighter window and because no references should
        // be below it.
        connection.setBaseMapping(0, message.minimumSequenceNumber);

        const services: IObjectServices = {
            deltaConnection: connection,
            objectStorage: localStorage,
        };

        const origin = message.origin ? message.origin.id : this.id;
        const value = await this.loadChannel(
            attachMessage.id,
            attachMessage.type,
            0,
            0,
            [],
            services,
            origin);

        return value;
    }

    public getQuorum(): IQuorum {
        this.verifyNotClosed();

        return this.quorum;
    }

    public hasUnackedOps(): boolean {
        this.verifyNotClosed();

        for (const state of this.channels.values()) {
            if (state.object.dirty) {
                return true;
            }
        }

        return false;
    }

    public snapshot(message: string): Promise<void> {
        this.verifyNotClosed();

        return this.snapshotFn(message);
    }

    public save(tag: string) {
        this.verifyNotClosed();
        this.submit(MessageType.Save, tag);
    }

    public async uploadBlob(file: IGenericBlob): Promise<IGenericBlob> {
        this.verifyNotClosed();

        const sha = gitHashFile(file.content);
        file.sha = sha;
        file.url = this.storageService.getRawUrl(sha);

        await this.blobManager.createBlob(file);
        this.submit(MessageType.BlobUploaded, await this.blobManager.createBlob(file));

        return file;
    }

    public getBlob(sha: string): Promise<IGenericBlob> {
        this.verifyNotClosed();

        return this.blobManager.getBlob(sha);
    }

    public transform(message: ISequencedDocumentMessage) {
        const envelope = message.contents as IEnvelope;
        const objectDetails = this.channels.get(envelope.address);
        envelope.contents = objectDetails.object.transform(
            envelope.contents as IObjectMessage,
            objectDetails.connection.transformDocumentSequenceNumber(
                Math.max(message.referenceSequenceNumber, this.deltaManager.minimumSequenceNumber)));
    }

    public async getBlobMetadata(): Promise<IGenericBlob[]> {
        return this.blobManager.getBlobMetadata();
    }

    public stop(): ITreeEntry[] {
        this.verifyNotClosed();

        this.closed = true;

        return this.snapshotInternal();
    }

    public close(): void {
        this.closeFn();
    }

    public updateMinSequenceNumber(msn: number) {
        for (const [, object] of this.channels) {
            if (!object.object.isLocal() && object.connection.baseMappingIsSet()) {
                object.connection.updateMinSequenceNumber(msn);
            }
        }
    }

    public snapshotInternal(): ITreeEntry[] {
        const entries = new Array<ITreeEntry>();

        // Craft the .attributes file for each distributed object
        for (const [objectId, object] of this.channels) {
            // If the object isn't local - and we have received the sequenced op creating the object (i.e. it has a
            // base mapping) - then we go ahead and snapshot
            if (!object.object.isLocal() && object.connection.baseMappingIsSet()) {
                const snapshot = object.object.snapshot();

                // Add in the object attributes to the returned tree
                const objectAttributes: IObjectAttributes = {
                    sequenceNumber: object.connection.minimumSequenceNumber,
                    type: object.object.type,
                };
                snapshot.entries.push({
                    mode: FileMode.File,
                    path: ".attributes",
                    type: TreeEntry[TreeEntry.Blob],
                    value: {
                        contents: JSON.stringify(objectAttributes),
                        encoding: "utf-8",
                    },
                });

                // And then store the tree
                entries.push({
                    mode: FileMode.Directory,
                    path: objectId,
                    type: TreeEntry[TreeEntry.Tree],
                    value: snapshot,
                });
            }
        }

        return entries;
    }

    public submitMessage(type: MessageType, content: any) {
        this.submit(type, content);
    }

    public registerTasks(tasks: string[], version?: string) {
        this.verifyNotClosed();
        this.tasks = tasks;
        this.version = version;
        this.startLeaderElection();
    }

    private submit(type: MessageType, content: any) {
        this.verifyNotClosed();
        this.submitFn(type, content);
    }

    private reserve(id: string) {
        if (!this.channelsDeferred.has(id)) {
            this.channelsDeferred.set(id, new Deferred<IChannel>());
        }
    }

    private async loadSnapshotChannel(
        runtime: IRuntime,
        id: string,
        tree: ISnapshotTree,
        storage: IDocumentStorageService,
        messages: ISequencedDocumentMessage[],
        branch: string,
        minimumSequenceNumber: number): Promise<void> {

        const channelAttributes = await readAndParse<IObjectAttributes>(storage, tree.blobs[".attributes"]);
        const services = this.getObjectServices(id, tree, storage);
        services.deltaConnection.setBaseMapping(channelAttributes.sequenceNumber, minimumSequenceNumber);

        // Run the transformed messages through the delta connection in order to update their offsets
        // Then pass these to the loadInternal call. Moving forward we will want to update the snapshot
        // to include the range maps. And then make the objects responsible for storing any messages they
        // need to transform.
        const transformedObjectMessages = messages.map((message) => {
            return services.deltaConnection.translateToObjectMessage(message, true);
        });

        const channelDetails = await this.loadChannel(
            id,
            channelAttributes.type,
            channelAttributes.sequenceNumber,
            channelAttributes.sequenceNumber,
            transformedObjectMessages,
            services,
            branch);

        assert(!this.channels.has(id));
        this.channels.set(id, channelDetails);
        this.channelsDeferred.get(id).resolve(channelDetails.object);
    }

    private async loadChannel(
        id: string,
        type: string,
        sequenceNumber: number,
        minSequenceNumber: number,
        messages: ISequencedObjectMessage[],
        services: IObjectServices,
        originBranch: string): Promise<IChannelState> {

        // Pass the transformedMessages - but the object really should be storing this
        const extension = this.chaincode.getModule(type) as IChaincodeModule;

        // TODO need to fix up the SN vs. MSN stuff here. If want to push messages to object also need
        // to store the mappings from channel ID to doc ID.
        const value = await extension.load(
            this,
            id,
            services.deltaConnection.sequenceNumber,
            minSequenceNumber,
            messages,
            services,
            originBranch);

        return { object: value, storage: services.objectStorage, connection: services.deltaConnection };
    }

    private getObjectServices(
        id: string,
        tree: ISnapshotTree,
        storage: IDocumentStorageService): IObjectServices {

        const deltaConnection = new ChannelDeltaConnection(
            id,
            this.connectionState,
            (message) => {
                const envelope: IEnvelope = { address: id, contents: message };
                this.submit(MessageType.Operation, envelope);
            });
        const objectStorage = new ChannelStorageService(tree, storage);

        return {
            deltaConnection,
            objectStorage,
        };
    }

    private verifyNotClosed() {
        if (this.closed) {
            throw new Error("Runtime is closed");
        }
    }

    private startLeaderElection() {
        if (this.deltaManager && this.deltaManager.clientType === Browser) {
            if (this.connected) {
                this.initLeaderElection();
            } else {
                const leaderElectionHandler = () => {
                    this.initLeaderElection();
                    this.removeListener("connected", leaderElectionHandler);
                };
                this.on("connected", leaderElectionHandler);
            }
        }
    }

    private initLeaderElection() {
        this.leaderElector = new LeaderElector(this.getQuorum(), this.clientId);
        this.leaderElector.on("newLeader", (clientId: string) => {
            debug(`New leader elected: ${clientId}`);
            this.runTaskAnalyzer();
        });
        this.leaderElector.on("leaderLeft", (clientId: string) => {
            debug(`Leader ${clientId} left`);
            this.proposeLeadership();
        });
        this.leaderElector.on("memberLeft", (clientId: string) => {
            debug(`Member ${clientId} left`);
            this.runTaskAnalyzer();
        });
        this.proposeLeadership();
    }

    private proposeLeadership() {
        if (getLeaderCandidate(this.getQuorum().getMembers()) === this.clientId) {
            this.leaderElector.proposeLeadership().then(() => {
                debug(`Proposal accepted`);
            }, (err) => {
                debug(`Proposal rejected: ${err}`);
            });
        }
    }

    /**
     * On a client joining/departure, decide whether this client is the new leader.
     * If so, calculate if there are any unhandled tasks for browsers and remote agents.
     * Emit local help message for this browser and submits a remote help message for agents.
     */
    private runTaskAnalyzer() {
        if (this.leaderElector.getLeader() === this.clientId) {
            // Analyze the current state and ask for local and remote help seperately.
            const helpTasks = analyzeTasks(this.clientId, this.getQuorum().getMembers(), this.tasks);
            if (helpTasks && (helpTasks.browser.length > 0 || helpTasks.robot.length > 0)) {
                if (helpTasks.browser.length > 0) {
                    const localHelpMessage: IHelpMessage = {
                        tasks: helpTasks.browser,
                        version: this.version,   // back-compat
                    };
                    console.log(`Requesting local help for ${helpTasks.browser}`);
                    this.emit("localHelp", localHelpMessage);
                }
                if (helpTasks.robot.length > 0) {
                    const remoteHelpMessage: IHelpMessage = {
                        tasks: helpTasks.robot,
                        version: this.version,   // back-compat
                    };
                    console.log(`Requesting remote help for ${helpTasks.robot}`);
                    this.submitMessage(MessageType.RemoteHelp, remoteHelpMessage);
                }
            }
        }
    }
}
