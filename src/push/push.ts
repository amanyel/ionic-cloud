import {
  IAuth,
  IClient,
  IConfig,
  IDevice,
  IEventEmitter,
  ILogger,
  IPluginNotification,
  IPluginRegistration,
  IPush,
  IPushToken,
  ISingleUserService,
  IStorage,
  PushDependencies,
  PushOptions,
  PushStorageObject,
  SaveTokenOptions
} from '../definitions';

import { DeferredPromise } from '../promise';

import { PushToken } from './token';
import { PushMessage } from './message';

declare var window: any;
declare var PushNotification: any;

interface ServiceTokenData {
  token: string;
  app_id: string;
  user_id?: string;
}

/**
 * Push handles push notifications for this app.
 */
export class Push implements IPush {

  /**
   * The push plugin.
   */
  public plugin: any;

  private config: IConfig;
  private auth: IAuth;
  private userService: ISingleUserService;
  private device: IDevice;
  private client: IClient;
  private emitter: IEventEmitter;
  private storage: IStorage<PushStorageObject>;
  private logger: ILogger;

  private blockRegistration: boolean = false;
  private blockUnregister: boolean = false;
  private blockSaveToken: boolean = false;
  private registered: boolean = false;

  private _token: IPushToken;

  constructor(
    deps: PushDependencies,
    public options: PushOptions = {}
  ) {
    this.config = deps.config;
    this.auth = deps.auth;
    this.userService = deps.userService;
    this.device = deps.device;
    this.client = deps.client;
    this.emitter = deps.emitter;
    this.storage = deps.storage;
    this.logger = deps.logger;

    // Check for the required values to use this service
    if (this.device.isAndroid() && !this.options.sender_id) {
      this.logger.error('Ionic Push: GCM project number not found (http://docs.ionic.io/docs/push-android-setup)');
      return;
    }

    if (!options.pluginConfig) { options.pluginConfig = {}; }

    if (this.device.isAndroid()) {
      // inject gcm key for PushPlugin
      if (!options.pluginConfig.android) { options.pluginConfig.android = {}; }
      if (!options.pluginConfig.android.senderID) { options.pluginConfig.android.senderID = this.options.sender_id; }
    }

    this.options = options;
  }

  public get token(): IPushToken {
    if (!this._token) {
      this._token = new PushToken(this.storage.get('push_token').token);
    }

    return this._token;
  }

  public set token(val: IPushToken) {
    if (!val) {
      this.storage.delete('push_token');
    } else {
      this.storage.set('push_token', { 'token': val.token });
    }

    this._token = val;
  }

  /**
   * Register a token with the API.
   *
   * When a token is saved, you can send push notifications to it. If a user is
   * logged in, the token is linked to them by their ID.
   *
   * @param token - The token.
   * @param options
   */
  public saveToken(token: IPushToken, options: SaveTokenOptions = {}): Promise<IPushToken> {
    let deferred = new DeferredPromise<IPushToken, Error>();

    let tokenData: ServiceTokenData = {
      'token': token.token,
      'app_id': this.config.get('app_id')
    };

    if (!options.ignore_user) {
      let user = this.userService.current();
      if (this.auth.isAuthenticated()) {
        tokenData.user_id = user.id;
      }
    }

    if (!this.blockSaveToken) {
      this.client.post('/push/tokens')
        .send(tokenData)
        .end((err, res) => {
          if (err) {
            this.blockSaveToken = false;
            this.logger.error('Ionic Push:', err);
            deferred.reject(err);
          } else {
            this.blockSaveToken = false;
            this.logger.info('Ionic Push: saved push token: ' + token);
            if (tokenData.user_id) {
              this.logger.info('Ionic Push: added push token to user: ' + tokenData.user_id);
            }
            token.saved = true;
            deferred.resolve(token);
          }
        });
    } else {
      deferred.reject(new Error('A token save operation is already in progress.'));
    }

    return deferred.promise;
  }

  /**
   * Registers the device with GCM/APNS to get a push token.
   *
   * After a device is registered, you will likely want to save the token to
   * the API.
   *
   * TODO: link to saveToken
   */
  public register(): Promise<IPushToken> {
    let deferred = new DeferredPromise<IPushToken, Error>();

    if (this.blockRegistration) {
      deferred.reject(new Error('Another registration is already in progress.'));
    } else {
      this.blockRegistration = true;
      this.emitter.once('device:ready', () => {
        let pushPlugin = this._getPushPlugin();

        if (pushPlugin) {
          this.plugin = pushPlugin.init(this.options.pluginConfig);
          this.plugin.on('registration', (data) => {
            this.blockRegistration = false;
            this.token = new PushToken(data.registrationId);
            this.token.registered = true;
            deferred.resolve(this.token);
          });
          this._callbackRegistration();
          this.registered = true;
        } else {
          deferred.reject(new Error('Push plugin not found! See logs.'));
        }
      });
    }

    return deferred.promise;
  }

  /**
   * Invalidate the current push token.
   */
  public unregister(): Promise<void> {
    let deferred = new DeferredPromise<void, Error>();

    if (!this.blockUnregister) {
      let pushToken = this.token;

      if (!pushToken) {
        deferred.resolve();
      } else {
        let tokenData: ServiceTokenData = {
          'token': pushToken.token,
          'app_id': this.config.get('app_id')
        };

        if (this.plugin) {
          this.plugin.unregister(function() {}, function() {});
        }
        this.client.post('/push/tokens/invalidate')
          .send(tokenData)
          .end((err, res) => {
            this.blockUnregister = false;

            if (err) {
              this.logger.error('Ionic Push:', err);
              deferred.reject(err);
            } else {
              this.logger.info('Ionic Push: unregistered push token: ' + pushToken.token);
              this.token = null;
              deferred.resolve();
            }
          });
      }
    } else {
      deferred.reject(new Error('An unregister operation is already in progress.'));
    }

    this.blockUnregister = true;

    return deferred.promise;
  }

  private _callbackRegistration() {
    this.plugin.on('registration', (data: IPluginRegistration) => {
      this.token = new PushToken(data.registrationId);

      if (this.options.debug) {
        this.logger.info('Ionic Push (debug): device token registered: ' + this.token);
      }

      this.emitter.emit('push:register', {'token': data.registrationId});
    });

    this.plugin.on('notification', (data: IPluginNotification) => {
      let message = PushMessage.fromPluginData(data);

      if (this.options.debug) {
        this.logger.info('Ionic Push (debug): notification received: ' + message);
      }

      this.emitter.emit('push:notification', {'message': message, 'raw': data});
    });

    this.plugin.on('error', (e: Error) => {
      if (this.options.debug) {
        this.logger.error('Ionic Push (debug): unexpected error occured.');
        this.logger.error('Ionic Push:', e);
      }

      this.emitter.emit('push:error', {'err': e});
    });
  }

  private _getPushPlugin() {
    let plugin = window.PushNotification;

    if (!plugin) {
      if (this.device.isIOS() || this.device.isAndroid()) {
        this.logger.error('Ionic Push: PushNotification plugin is required. Have you run `ionic plugin add phonegap-plugin-push` ?');
      } else {
        this.logger.warn('Ionic Push: Disabled! Native push notifications will not work in a browser. Run your app on an actual device to use push.');
      }
    }

    return plugin;
  }

}
