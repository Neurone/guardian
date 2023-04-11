import {
    Logger,
    MessageBrokerChannel,
    MessageResponse,
    NatsService,
    SecretManager,
    ValidateConfiguration
} from '@guardian/common';
import {
    ExternalMessageEvents, GenerateUUIDv4,
    ITask,
    ITaskResult,
    WorkerEvents,
    WorkerTaskType
} from '@guardian/interfaces';
import { HederaSDKHelper, NetworkOptions } from './helpers/hedera-sdk-helper';
import { IpfsClient } from './ipfs-client';
import Blob from 'cross-blob';
import { AccountId, ContractFunctionParameters, PrivateKey, TokenId } from '@hashgraph/sdk';
import { HederaUtils } from './helpers/utils';
import axios from 'axios';
import process from 'process';

/**
 * Sleep helper
 * @param t
 */
function rejectTimeout(t: number): Promise<void> {
    return new Promise((_, reject) => {
        setTimeout(() => {
            reject(new Error('Timeout error'));
        }, t);
    })
}

/**
 * Worker class
 */
export class Worker extends NatsService {
    /**
     * Logger instance
     * @private
     */
    private readonly logger: Logger;

    /**
     * Message queue name
     */
    public messageQueueName = 'workers-queue';

    /**
     * Reply subject
     * @private
     */
    public replySubject = 'workers-queue-reply-' + GenerateUUIDv4();

    /**
     * Old channel
     * @private
     */
    private channel: MessageBrokerChannel;

    /**
     * Ipfs client
     */
    private ipfsClient: IpfsClient;

    /**
     * Current task ID
     */
    private currentTaskId: string;

    /**
     * Worker in use
     * @private
     */
    private _isInUse: boolean = false;

    /**
     * Worker in use getter
     * @private
     */
    private get isInUse(): boolean {
        return this._isInUse;
    }

    /**
     * Worker in use setter
     * @private
     */
    private set isInUse(v: boolean) {
        this._isInUse = v;
    }

    /**
     * Minimum priority
     * @private
     */
    private readonly minPriority: number;

    /**
     * Maximum priority
     * @private
     */
    private readonly maxPriority: number;

    /**
     * Task timeout
     * @private
     */
    private readonly taskTimeout: number;

    constructor(
    ) {
        super();
        const { IPFS_STORAGE_API_KEY } = new SettingsContainer().settings;

        this.logger = new Logger();
        this.ipfsClient = new IpfsClient(IPFS_STORAGE_API_KEY);
        const secretManager = SecretManager.New()
        secretManager.getSecrets('apikey/ipfs').
            then(secrets => {
                const { IPFS_STORAGE_API_KEY } = secrets;
                this.ipfsClient = new IpfsClient(IPFS_STORAGE_API_KEY);
            })

        this.logger = new Logger();

        this.minPriority = parseInt(process.env.MIN_PRIORITY, 10);
        this.maxPriority = parseInt(process.env.MAX_PRIORITY, 10);
        this.taskTimeout = parseInt(process.env.TASK_TIMEOUT, 10) * 1000; // env in seconds
    }

    /**
     * Initialize worker
     */
    public async init(): Promise<void> {
        await super.init();
        this.channel = new MessageBrokerChannel(this.connection, 'worker');

        this.subscribe(WorkerEvents.GET_FREE_WORKERS, async (msg) => {
            if (!this.isInUse) {
                this.publish(msg.replySubject, {
                    subject: [this.replySubject, WorkerEvents.SEND_TASK_TO_WORKER].join('.'),
                    minPriority: this.minPriority,
                    maxPriority: this.maxPriority
                })
            }
        });

        const runTask = async (task) => {
            this.isInUse = true;
            this.currentTaskId = task.id;

            this.logger.info(`Task started: ${task.id}, ${task.type}`, [process.env.SERVICE_CHANNEL]);

            const result = await this.processTaskWithTimeout(task);

            try {
                // await this.publish([task.reply, WorkerEvents.TASK_COMPLETE].join('-'), result);
                if (result?.error) {
                    this.logger.error(`Task error: ${this.currentTaskId}, ${result?.error}`, [process.env.SERVICE_CHANNEL]);
                } else {
                    this.logger.info(`Task completed: ${this.currentTaskId}`, [process.env.SERVICE_CHANNEL]);
                }
            } catch (error) {
                this.logger.error(error.message, [process.env.SERVICE_CHANNEL]);
                this.clearState();

            }

            const completeTask = (data) => {
                // let count = 0;
                const fn = async () => {
                    await this.publish([task.reply, WorkerEvents.TASK_COMPLETE].join('.'), data);
                    // if (count < 5) {
                    //     setTimeout(async () => {
                    //         await fn()
                    //     })
                    //     count++
                    // }
                }
                fn();
            }

            await completeTask(result);
            // await this.publish([task.reply, WorkerEvents.TASK_COMPLETE].join('.'), result);
            await this.publish(WorkerEvents.WORKER_READY);
            this.isInUse = false;
        }

        this.channel.subscribe(WorkerEvents.UPDATE_SETTINGS, async (msg: any) => {
            const secretManager = SecretManager.New();
            await secretManager.setSecrets('apikey/ipfs', {
                IPFS_STORAGE_API_KEY: msg.ipfsStorageApiKey,
            });
            this.ipfsClient = new IpfsClient(msg.ipfsStorageApiKey);
        }
        this.getMessages([this.replySubject, WorkerEvents.SEND_TASK_TO_WORKER].join('.'), async (task) => {
            if (!this.isInUse) {
                runTask(task);

                return new MessageResponse({
                    result: true
                })
            }
            return new MessageResponse({
                result: false
            })
        })

        this.subscribe(WorkerEvents.UPDATE_SETTINGS, async (msg: any) => {
            await new SettingsContainer().updateSetting('IPFS_STORAGE_API_KEY', msg.ipfsStorageApiKey);
            try {
                this.ipfsClient = new IpfsClient(msg.ipfsStorageApiKey);
                const validator = new ValidateConfiguration();
                await validator.validate();
            } catch (error) {
                this.logger.error(`Update settings error, ${error.message}`, ['WORKER']);
            }
        });

        HederaSDKHelper.setTransactionResponseCallback(async (client: any) => {
            try {
                const balance = await HederaSDKHelper.balance(client, client.operatorAccountId);
                await this.sendMessage('update-user-balance', {
                    balance,
                    unit: 'Hbar',
                    operatorAccountId: client.operatorAccountId.toString()
                });
            } catch (error) {
                throw new Error(`Worker (${['api-gateway', 'update-user-balance'].join('.')}) send: ` + error);
            }
        })
    }

    /**
     * Clear states
     * @private
     */
    private clearState(): void {
        this.isInUse = false;
        this.currentTaskId = null;
    }

    /**
     * Task actions
     * @param task
     * @private
     */
    private async processTask(task: ITask): Promise<ITaskResult> {
        const result: ITaskResult = {
            id: this.currentTaskId
        }
        const networkOptions: NetworkOptions = {
            network: task.data.network,
            localNodeAddress: task.data.localNodeAddress,
            localNodeProtocol: task.data.localNodeProtocol,
            nodes: task.data.nodes,
            mirrorNodes: task.data.mirrorNodes
        }
        try {
            switch (task.type) {
                case WorkerTaskType.ADD_FILE: {
                    let fileContent = Buffer.from(task.data.payload.content, 'base64');
                    const data = await this.channel.request<any, any>(ExternalMessageEvents.IPFS_BEFORE_UPLOAD_CONTENT, task.data.payload);
                    if (data && data.body) {
                        fileContent = Buffer.from(data.body, 'base64')
                    }
                    const blob: any = new Blob([fileContent]);
                    const r = await this.ipfsClient.addFile(blob);
                    this.publish(ExternalMessageEvents.IPFS_ADDED_FILE, r);
                    result.data = r;
                    break;
                }

                case WorkerTaskType.GET_FILE: {
                    if (!task.data.payload || !task.data.payload.cid || !task.data.payload.responseType) {
                        result.error = 'Invalid CID';
                    } else {
                        let fileContent = await this.ipfsClient.getFile(task.data.payload.cid);
                        if (fileContent instanceof Buffer) {
                            const data = await this.channel.request<any, any>(ExternalMessageEvents.IPFS_AFTER_READ_CONTENT, {
                                responseType: !task.data.payload.responseType,
                                content: fileContent.toString('base64'),
                            });
                            if (data && data.body) {
                                fileContent = Buffer.from(data.body, 'base64')
                            }
                        }

                        switch (task.data.payload.responseType) {
                            case 'str':
                                result.data = Buffer.from(fileContent, 'binary').toString();
                                break;

                            case 'json':
                                result.data = Buffer.from(fileContent, 'binary').toJSON();
                                break;

                            default:
                                result.data = fileContent
                        }
                    }
                    break;
                }

                case WorkerTaskType.HTTP_REQUEST: {
                    const { method, url, headers, body } = task.data.payload;
                    const response = await axios({
                        method,
                        url,
                        headers,
                        data: body
                    });
                    result.data = response.data;
                    break;
                }

                case WorkerTaskType.SEND_HEDERA: {
                    const { operatorId, operatorKey, dryRun } = task.data.clientOptions;
                    const client = new HederaSDKHelper(operatorId, operatorKey, dryRun, networkOptions);
                    const { topicId, buffer, submitKey, memo } = task.data;
                    result.data = await client.submitMessage(topicId, buffer, submitKey, memo);
                    break;
                }

                case WorkerTaskType.GENERATE_DEMO_KEY: {
                    const { operatorId, operatorKey, initialBalance } = task.data;
                    const client = new HederaSDKHelper(operatorId, operatorKey, null, networkOptions);
                    const treasury = await client.newAccount(initialBalance);
                    result.data = {
                        id: treasury.id.toString(),
                        key: treasury.key.toString()
                    };
                    break;
                }

                case WorkerTaskType.GET_USER_BALANCE: {
                    const { hederaAccountId, hederaAccountKey } = task.data;
                    const client = new HederaSDKHelper(hederaAccountId, hederaAccountKey, null, networkOptions);
                    result.data = await client.balance(hederaAccountId);

                    break;
                }

                case WorkerTaskType.GET_ACCOUNT_INFO: {
                    const { userID, userKey, hederaAccountId } = task.data;
                    const client = new HederaSDKHelper(userID, userKey, null, networkOptions);
                    result.data = await client.accountInfo(hederaAccountId);

                    break;
                }

                case WorkerTaskType.CREATE_TOKEN: {
                    const {
                        operatorId,
                        operatorKey,
                        memo,
                        decimals,
                        enableAdmin,
                        enableFreeze,
                        enableKYC,
                        enableWipe,
                        initialSupply,
                        tokenName,
                        tokenSymbol,
                        tokenType
                    } = task.data;
                    const client = new HederaSDKHelper(operatorId, operatorKey, null, networkOptions);
                    const nft = tokenType === 'non-fungible';
                    const _decimals = nft ? 0 : decimals;
                    const _initialSupply = nft ? 0 : initialSupply;
                    const treasuryId = AccountId.fromString(operatorId);
                    const treasuryKey = HederaUtils.parsPrivateKey(operatorKey);
                    const supplyKey = PrivateKey.generate();
                    const adminKey = enableAdmin ? PrivateKey.generate() : null;
                    const freezeKey = enableFreeze ? PrivateKey.generate() : null;
                    const kycKey = enableKYC ? PrivateKey.generate() : null;
                    const wipeKey = enableWipe ? PrivateKey.generate() : null;
                    const tokenMemo = memo || '';
                    const tokenId = await client.newToken(
                        tokenName,
                        tokenSymbol,
                        nft,
                        _decimals,
                        _initialSupply,
                        tokenMemo,
                        treasuryId,
                        treasuryKey,
                        supplyKey,
                        adminKey,
                        kycKey,
                        freezeKey,
                        wipeKey
                    );
                    result.data = {
                        tokenId,
                        tokenName,
                        tokenSymbol,
                        tokenType,
                        decimals: _decimals,
                        initialSupply: _initialSupply,
                        treasuryId: treasuryId.toString(),
                        treasuryKey: treasuryKey.toString(),
                        supplyKey: supplyKey.toString(),
                        adminKey: adminKey ? adminKey.toString() : null,
                        freezeKey: freezeKey ? freezeKey.toString() : null,
                        kycKey: kycKey ? kycKey.toString() : null,
                        wipeKey: wipeKey ? wipeKey.toString() : null
                    }
                    break;
                }

                case WorkerTaskType.UPDATE_TOKEN: {
                    const {
                        tokenId,
                        operatorId,
                        operatorKey,
                        adminKey,
                        changes
                    } = task.data;

                    if (changes.freezeKey) {
                        changes.freezeKey = PrivateKey.generate();
                    }
                    if (changes.kycKey) {
                        changes.kycKey = PrivateKey.generate();
                    }
                    if (changes.wipeKey) {
                        changes.wipeKey = PrivateKey.generate();
                    }
                    const client = new HederaSDKHelper(operatorId, operatorKey, null, networkOptions);
                    const status = await client.updateToken(
                        TokenId.fromString(tokenId),
                        HederaUtils.parsPrivateKey(adminKey, true, 'Admin Key'),
                        changes
                    )

                    result.data = {
                        status,
                        freezeKey: changes.freezeKey ? changes.freezeKey.toString() : null,
                        kycKey: changes.kycKey ? changes.kycKey.toString() : null,
                        wipeKey: changes.wipeKey ? changes.wipeKey.toString() : null
                    }

                    break;
                }

                case WorkerTaskType.DELETE_TOKEN: {
                    const {
                        tokenId,
                        operatorId,
                        operatorKey,
                        adminKey,
                    } = task.data;

                    const client = new HederaSDKHelper(operatorId, operatorKey, null, networkOptions);
                    result.data = await client.deleteToken(
                        TokenId.fromString(tokenId),
                        HederaUtils.parsPrivateKey(adminKey, true, 'Admin Key')
                    )

                    break;
                }

                case WorkerTaskType.ASSOCIATE_TOKEN: {
                    const { userID, userKey, associate, tokenId, dryRun } = task.data;
                    const client = new HederaSDKHelper(userID, userKey, dryRun, networkOptions);
                    if (associate) {
                        result.data = await client.associate(tokenId, userID, userKey);
                    } else {
                        result.data = await client.dissociate(tokenId, userID, userKey);
                    }

                    break;
                }

                case WorkerTaskType.GRANT_KYC_TOKEN: {
                    const {
                        hederaAccountId,
                        hederaAccountKey,
                        userHederaAccountId,
                        tokenId,
                        kycKey,
                        grant,
                        dryRun
                    } = task.data;
                    const client = new HederaSDKHelper(hederaAccountId, hederaAccountKey, dryRun, networkOptions);

                    if (grant) {
                        result.data = await client.grantKyc(tokenId, userHederaAccountId, kycKey);
                    } else {
                        result.data = await client.revokeKyc(tokenId, userHederaAccountId, kycKey);
                    }

                    break;
                }

                case WorkerTaskType.FREEZE_TOKEN: {
                    const {
                        hederaAccountId,
                        hederaAccountKey,
                        userHederaAccountId,
                        tokenId,
                        freezeKey,
                        freeze,
                        dryRun
                    } = task.data;
                    const client = new HederaSDKHelper(hederaAccountId, hederaAccountKey, dryRun, networkOptions);
                    if (freeze) {
                        result.data = await client.freeze(tokenId, userHederaAccountId, freezeKey);
                    } else {
                        result.data = await client.unfreeze(tokenId, userHederaAccountId, freezeKey);
                    }

                    break;
                }

                case WorkerTaskType.MINT_NFT: {
                    const { hederaAccountId, hederaAccountKey, dryRun, tokenId, supplyKey, metaData, transactionMemo } = task.data;
                    const client = new HederaSDKHelper(hederaAccountId, hederaAccountKey, dryRun, networkOptions);
                    let data: Uint8Array[];
                    if (Array.isArray(metaData)) {
                        data = new Array<Uint8Array>(metaData.length);
                        for (let i = 0; i < metaData.length; i++) {
                            data[i] = new Uint8Array(Buffer.from(metaData[i]));
                        }
                    } else {
                        data = [new Uint8Array(Buffer.from(metaData))];
                    }
                    result.data = await client.mintNFT(tokenId, supplyKey, data, transactionMemo);
                    break;
                }

                case WorkerTaskType.TRANSFER_NFT: {
                    const {
                        hederaAccountId,
                        hederaAccountKey,
                        dryRun,
                        tokenId,
                        targetAccount,
                        treasuryId,
                        treasuryKey,
                        element,
                        transactionMemo
                    } = task.data;
                    const client = new HederaSDKHelper(hederaAccountId, hederaAccountKey, dryRun, networkOptions);
                    result.data = await client.transferNFT(tokenId, targetAccount, treasuryId, treasuryKey, element, transactionMemo);
                    break;
                }

                case WorkerTaskType.MINT_FT: {
                    const { hederaAccountId, hederaAccountKey, dryRun, tokenId, supplyKey, tokenValue, transactionMemo } = task.data;
                    const client = new HederaSDKHelper(hederaAccountId, hederaAccountKey, dryRun, networkOptions);
                    result.data = await client.mint(tokenId, supplyKey, tokenValue, transactionMemo);
                    break;
                }

                case WorkerTaskType.TRANSFER_FT: {
                    const {
                        hederaAccountId,
                        hederaAccountKey,
                        dryRun,
                        tokenId,
                        targetAccount,
                        treasuryId,
                        treasuryKey,
                        tokenValue,
                        transactionMemo
                    } = task.data;
                    const client = new HederaSDKHelper(hederaAccountId, hederaAccountKey, dryRun, networkOptions);
                    result.data = await client.transfer(tokenId, targetAccount, treasuryId, treasuryKey, tokenValue, transactionMemo);
                    break;
                }

                case WorkerTaskType.WIPE_TOKEN: {
                    const {
                        hederaAccountId,
                        hederaAccountKey,
                        targetAccount,
                        tokenValue,
                        dryRun,
                        token,
                        wipeKey,
                        uuid
                    } = task.data;
                    const client = new HederaSDKHelper(hederaAccountId, hederaAccountKey, dryRun, networkOptions);
                    if (token.tokenType === 'non-fungible') {
                        result.error = 'unsupported operation';
                    } else {
                        await client.wipe(token.tokenId, targetAccount, wipeKey, tokenValue, uuid);
                        result.data = {}
                    }
                    break;
                }

                case WorkerTaskType.NEW_TOPIC: {
                    const { hederaAccountId, hederaAccountKey, dryRun, topicMemo, keys } = task.data;
                    const client = new HederaSDKHelper(hederaAccountId, hederaAccountKey, dryRun, networkOptions);
                    let adminKey: any = null;
                    let submitKey: any = null;
                    if (keys) {
                        if (keys.admin) {
                            adminKey = hederaAccountKey;
                        }
                        if (keys.submit) {
                            submitKey = hederaAccountKey;
                        }
                    } else {
                        adminKey = hederaAccountKey;
                        submitKey = hederaAccountKey;
                    }
                    result.data = await client.newTopic(
                        adminKey,
                        submitKey,
                        topicMemo
                    );

                    break;
                }

                case WorkerTaskType.GET_TOPIC_MESSAGE: {
                    const {
                        operatorId,
                        operatorKey,
                        dryRun,
                        timeStamp
                    } = task.data;
                    const client = new HederaSDKHelper(operatorId, operatorKey, dryRun, networkOptions);
                    result.data = await client.getTopicMessage(timeStamp);

                    break;
                }

                case WorkerTaskType.GET_TOPIC_MESSAGES: {
                    const {
                        operatorId,
                        operatorKey,
                        dryRun,
                        topic
                    } = task.data;
                    const client = new HederaSDKHelper(operatorId, operatorKey, dryRun, networkOptions);
                    result.data = await client.getTopicMessages(topic);

                    break;
                }

                case WorkerTaskType.CHECK_ACCOUNT: {
                    const { hederaAccountId } = task.data;
                    result.data = !HederaSDKHelper.checkAccount(hederaAccountId);

                    break;
                }

                case WorkerTaskType.CREATE_CONTRACT: {
                    const {
                        hederaAccountId,
                        hederaAccountKey,
                        topicKey,
                        bytecodeFileId,
                        memo
                    } = task.data;
                    const contractMemo = memo || '';
                    const client = new HederaSDKHelper(
                        hederaAccountId,
                        hederaAccountKey,
                        null,
                        networkOptions
                    );
                    result.data = await client.createContract(
                        bytecodeFileId,
                        new ContractFunctionParameters().addString(topicKey),
                        contractMemo
                    );
                    break;
                }

                case WorkerTaskType.ADD_CONTRACT_USER: {
                    const {
                        hederaAccountId,
                        hederaAccountKey,
                        userId,
                        contractId,
                    } = task.data;
                    const client = new HederaSDKHelper(
                        hederaAccountId,
                        hederaAccountKey,
                        null,
                        networkOptions
                    );
                    result.data = await client.contractCall(
                        contractId, 'addUser',
                        new ContractFunctionParameters().addAddress(AccountId.fromString(userId).toSolidityAddress())
                    );
                    break;
                }

                case WorkerTaskType.ADD_CONTRACT_PAIR: {
                    const {
                        hederaAccountId,
                        hederaAccountKey,
                        contractId,
                        baseTokenId,
                        oppositeTokenId,
                        baseTokenCount,
                        oppositeTokenCount,
                        grantKycKeys,
                    } = task.data;
                    const client = new HederaSDKHelper(
                        hederaAccountId,
                        hederaAccountKey,
                        null,
                        networkOptions
                    );
                    result.data = await client.contractCall(
                        contractId,
                        'addPair',
                        new ContractFunctionParameters()
                            .addAddress(
                                baseTokenId
                                    ? TokenId.fromString(
                                        baseTokenId
                                    ).toSolidityAddress()
                                    : new TokenId(0).toSolidityAddress()
                            )
                            .addAddress(
                                oppositeTokenId
                                    ? TokenId.fromString(
                                        oppositeTokenId
                                    ).toSolidityAddress()
                                    : new TokenId(0).toSolidityAddress()
                            )
                            .addUint32(Math.floor(baseTokenCount || 0))
                            .addUint32(Math.floor(oppositeTokenCount || 0)),
                        grantKycKeys
                    );
                    break;
                }

                case WorkerTaskType.GET_CONTRACT_INFO: {
                    const {
                        hederaAccountId,
                        hederaAccountKey,
                        contractId,
                    } = task.data;
                    const client = new HederaSDKHelper(
                        hederaAccountId,
                        hederaAccountKey,
                        null,
                        networkOptions
                    );
                    const address = await client.contractQuery(
                        contractId,
                        'getOwner',
                        new ContractFunctionParameters()
                    );
                    const owner = AccountId.fromSolidityAddress(address.getAddress()).toString();
                    const info = await client.getContractInfo(contractId);
                    result.data = {
                        owner,
                        memo: info.contractMemo
                    };
                    break;
                }

                case WorkerTaskType.CHECK_STATUS: {
                    const {
                        hederaAccountId,
                        hederaAccountKey,
                        contractId,
                    } = task.data;
                    const client = new HederaSDKHelper(
                        hederaAccountId,
                        hederaAccountKey,
                        null,
                        networkOptions
                    );
                    result.data = (await client.contractQuery(
                        contractId, 'checkStatus',
                        new ContractFunctionParameters()
                    )).getBool();
                    break;
                }

                case WorkerTaskType.RETIRE_TOKENS: {
                    const {
                        hederaAccountId,
                        hederaAccountKey,
                        baseTokenId,
                        oppositeTokenId,
                        userId,
                        contractId,
                        wipeKeys
                    } = task.data;
                    const client = new HederaSDKHelper(
                        hederaAccountId,
                        hederaAccountKey,
                        null,
                        networkOptions
                    );
                    result.data = await client.contractCall(
                        contractId,
                        'retire',
                        new ContractFunctionParameters()
                            .addAddress(
                                AccountId.fromString(userId).toSolidityAddress()
                            )
                            .addAddress(
                                baseTokenId
                                    ? TokenId.fromString(
                                        baseTokenId
                                    ).toSolidityAddress()
                                    : new TokenId(0).toSolidityAddress()
                            )
                            .addAddress(
                                oppositeTokenId
                                    ? TokenId.fromString(
                                        oppositeTokenId
                                    ).toSolidityAddress()
                                    : new TokenId(0).toSolidityAddress()
                            ),
                        wipeKeys
                    );
                    break;
                }

                case WorkerTaskType.CANCEL_RETIRE_REQUEST: {
                    const {
                        hederaAccountId,
                        hederaAccountKey,
                        baseTokenId,
                        oppositeTokenId,
                        contractId
                    } = task.data;
                    const client = new HederaSDKHelper(
                        hederaAccountId,
                        hederaAccountKey,
                        null,
                        networkOptions
                    );
                    result.data = await client.contractCall(
                        contractId,
                        'cancelUserRequest',
                        new ContractFunctionParameters()
                            .addAddress(
                                baseTokenId
                                    ? TokenId.fromString(
                                        baseTokenId
                                    ).toSolidityAddress()
                                    : new TokenId(0).toSolidityAddress()
                            )
                            .addAddress(
                                oppositeTokenId
                                    ? TokenId.fromString(
                                        oppositeTokenId
                                    ).toSolidityAddress()
                                    : new TokenId(0).toSolidityAddress()
                            )
                    );
                    break;
                }

                case WorkerTaskType.GET_CONTRACT_PAIR: {
                    const {
                        hederaAccountId,
                        hederaAccountKey,
                        baseTokenId,
                        oppositeTokenId,
                        contractId
                    } = task.data;
                    const client = new HederaSDKHelper(
                        hederaAccountId,
                        hederaAccountKey,
                        null,
                        networkOptions
                    );
                    const contractQueryResult = await client.contractQuery(
                        contractId,
                        'getPair',
                        new ContractFunctionParameters()
                            .addAddress(
                                baseTokenId
                                    ? TokenId.fromString(
                                        baseTokenId
                                    ).toSolidityAddress()
                                    : new TokenId(0).toSolidityAddress()
                            )
                            .addAddress(
                                oppositeTokenId
                                    ? TokenId.fromString(
                                        oppositeTokenId
                                    ).toSolidityAddress()
                                    : new TokenId(0).toSolidityAddress()
                            )
                    );
                    result.data = {
                        baseTokenRate: contractQueryResult.getUint32(0),
                        oppositeTokenRate: contractQueryResult.getUint32(1),
                        contractId
                    };
                    break;
                }

                case WorkerTaskType.ADD_RETIRE_REQUEST: {
                    const {
                        hederaAccountId,
                        hederaAccountKey,
                        baseTokenId,
                        oppositeTokenId,
                        baseTokenCount,
                        oppositeTokenCount,
                        baseTokenSerials,
                        oppositeTokenSerials,
                        contractId
                    } = task.data;
                    const client = new HederaSDKHelper(
                        hederaAccountId,
                        hederaAccountKey,
                        null,
                        networkOptions
                    );
                    result.data = await client.contractCall(
                        contractId,
                        'addUserRequest',
                        new ContractFunctionParameters()
                            .addAddress(
                                baseTokenId
                                    ? TokenId.fromString(
                                        baseTokenId
                                    ).toSolidityAddress()
                                    : new TokenId(0).toSolidityAddress()
                            )
                            .addAddress(
                                oppositeTokenId
                                    ? TokenId.fromString(
                                        oppositeTokenId
                                    ).toSolidityAddress()
                                    : new TokenId(0).toSolidityAddress()
                            )
                            .addUint32(baseTokenCount)
                            .addUint32(oppositeTokenCount)
                            .addInt64Array(
                                baseTokenSerials && baseTokenSerials.length
                                    ? baseTokenSerials
                                    : [0]
                            )
                            .addInt64Array(
                                oppositeTokenSerials &&
                                    oppositeTokenSerials.length
                                    ? oppositeTokenSerials
                                    : [0]
                            )
                    );
                    break;
                }

                case WorkerTaskType.GET_RETIRE_REQUEST: {
                    const {
                        hederaAccountId,
                        hederaAccountKey,
                        baseTokenId,
                        oppositeTokenId,
                        userId,
                        contractId
                    } = task.data;
                    const client = new HederaSDKHelper(
                        hederaAccountId,
                        hederaAccountKey,
                        null,
                        networkOptions
                    );
                    const contractQueryResult = await client.contractQuery(
                        contractId,
                        'getUserRequest',
                        new ContractFunctionParameters()
                            .addAddress(
                                AccountId.fromString(userId).toSolidityAddress()
                            )
                            .addAddress(
                                baseTokenId
                                    ? TokenId.fromString(
                                        baseTokenId
                                    ).toSolidityAddress()
                                    : new TokenId(0).toSolidityAddress()
                            )
                            .addAddress(
                                oppositeTokenId
                                    ? TokenId.fromString(
                                        oppositeTokenId
                                    ).toSolidityAddress()
                                    : new TokenId(0).toSolidityAddress()
                            )
                    );
                    result.data = {
                        baseTokenCount: contractQueryResult.getUint32(0) || contractQueryResult.getUint32(2),
                        oppositeTokenCount: contractQueryResult.getUint32(1) || contractQueryResult.getUint32(3)
                    }
                    break;
                }

                case WorkerTaskType.GET_USER_NFTS_SERIALS: {
                    const {
                        operatorId,
                        operatorKey,
                        tokenId,
                    } = task.data;
                    const client = new HederaSDKHelper(operatorId, operatorKey, null, networkOptions);
                    const nfts = (await client.getSerialsNFT(tokenId)) || [];
                    const serials = {};
                    nfts.forEach(item => {
                        if (serials[item.token_id]) {
                            serials[item.token_id].push(item.serial_number);
                        } else {
                            serials[item.token_id] = [item.serial_number];
                        }
                    });
                    result.data = serials;
                    break;
                }

                default:
                    result.error = 'unknown task'
            }
            ///////
        } catch (e) {
            result.error = e.message;
        }

        return result;
    }

    /**
     * Process with timeout
     * @param task
     * @private
     */
    private processTaskWithTimeout(task: ITask): Promise<ITaskResult> {
        return new Promise(async (resolve, reject) => {
            try {
                const result = await Promise.race([
                    this.processTask(task),
                    rejectTimeout(this.taskTimeout)
                ]);
                resolve(result as ITaskResult);
            } catch (e) {
                const error = {
                    id: this.currentTaskId,
                    error: 'Unknown error'
                }
                if (e) {
                    error.error = e.message || e;
                }
                resolve(error);
            }
        })
    }
}
