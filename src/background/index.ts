import {IncomingMessage} from 'http';
import https from 'https';
import {getExceptionError} from './get-exception-error';
import {ChromeMessage, ChromeMessageType} from './interfaces';
import {DownloadManager} from './services/download-manager';
import {DownloadItem} from './services/download-manager/interfaces';
import {TrackID3TagWriter} from './services/id3-tag-writer';
import {UserSettings} from './services/user-settings';
import {YandexMusicAPI} from './services/yandex-music-api';
import {Track} from './services/yandex-music-api/interfaces';

type ErrorCallback = (err: Error) => void;

function getTrackTitle(track: Track): string {
  if (track.version === undefined) {
    return track.title;
  }

  return `${track.title} ${track.version}`;
}

function getAlbumTitle(track: Track): string {
  // eslint-disable-next-line prettier/prettier
  const {albums: [album]} = track;

  if (album === undefined) {
    return '';
  }

  if (album.version === undefined) {
    return album.title;
  }

  return `${album.title} ${album.version}`;
}

export class BackgroundApiService {
  private yandexMusicApi: YandexMusicAPI;

  static userSettings: UserSettings;
  static downloadManager: DownloadManager;

  private static errorListeners_: ErrorCallback[] = [];
  private static completeEventCallback_: (
    downloadItem: DownloadItem,
  ) => Promise<void>;
  protected static instance_: BackgroundApiService | null;
  /**
   * @return instance of BackgroundApiService.
   * It shares downloadManager and userSettings with other instances
   */
  static async getInstance(locale: string): Promise<BackgroundApiService> {
    const yma = new YandexMusicAPI(locale);

    if (!this.userSettings) {
      this.userSettings = new UserSettings();
      await this.userSettings.load();
    }
    if (!this.downloadManager) {
      this.downloadManager = new DownloadManager(this.userSettings.concurrency);
      this.completeEventCallback_ = async item => {
        await this.processDownloadItem_(item);
      };
      this.downloadManager.on('complete', this.completeEventCallback_);
    }

    return new BackgroundApiService(
      yma,
      this.userSettings,
      this.downloadManager,
    );
  }
  /**
   * Save reference to downloadManager userSettings and yandexMusicApi
   */
  private constructor(
    yandexMusicApi: YandexMusicAPI,
    userSettings: UserSettings,
    downloadManager: DownloadManager,
  ) {
    this.yandexMusicApi = yandexMusicApi;
    BackgroundApiService.userSettings = userSettings;
    BackgroundApiService.downloadManager = downloadManager;
  }

  /**
   * Passes error object to all error listeners
   */
  private static emitError_(err: Error) {
    console.error(err);
    for (const callback of this.errorListeners_) {
      callback(err);
    }
  }
  /**
   * Downloads buffer
   */
  private static async downloadCover_(uri: string): Promise<Buffer> {
    const options = {
      path: uri,
      headers: {
        Connection: 'keep-alive',
        Accept: '*/*',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'origin, content-type, accept',
      },
    };

    return new Promise<Buffer>((resolve, reject) => {
      https
        .get(options, (res: IncomingMessage) => {
          const rawData: Buffer[] = [];
          res.on('data', (chunk: Buffer) => rawData.push(chunk));
          res.on('error', reject);
          res.on('end', () => resolve(Buffer.concat(rawData)));
        })
        .on('error', reject);
    });
  }
  /**
   * Used as callback to onComplete event on downloadManager.
   * Sets id3 tags and saves file to specified folder
   */
  private static async processDownloadItem_(item: DownloadItem) {
    if (!item.customData?.trackId) return;
    if (!item.customData?.locale) return;

    const yandexMusicApi = new YandexMusicAPI(item.customData.locale as string);

    try {
      /* get track info */
      const {track, lyric} = await yandexMusicApi.getTrack(
        +item.customData.trackId,
      );

      /* set id3 tags */
      const tagWriter = new TrackID3TagWriter(item.bytes!);

      tagWriter
        .setTitle(getTrackTitle(track))
        .setType(track.type)
        .setDuration(track.durationMs);

      /* set album info */
      if (track.albums.length > 0) {
        tagWriter
          .setPositionInAlbum(track.albums[0].trackPosition.index)
          .setVolume(track.albums[0].trackPosition.volume)
          .setGenre(track.albums[0].genre)
          .setAlbum({
            title: getAlbumTitle(track),
            artist:
              track.albums[0].artists.length > 0
                ? track.albums[0].artists[0].name
                : undefined,
            year: track.albums[0].year,
          });
      }

      /* set artist info */
      if (track.artists.length > 0) {
        tagWriter.setArtists(track.artists.map(artist => artist.name));
      }

      /* set cover */
      if (track.coverUri) {
        const cover = await this.downloadCover_(
          await yandexMusicApi.getCoverDownloadLink(
            track.coverUri,
            BackgroundApiService.userSettings.coverSize,
          ),
        );
        tagWriter.setCover(cover, getTrackTitle(track));
      }

      if (track.albums[0].labels.length !== 0) {
        tagWriter.setLabels(track.albums[0].labels.map(label => label.name));
      }

      if (lyric.length !== 0) {
        tagWriter.setLyric(
          lyric[0].fullLyrics,
          lyric[0].fullLyrics && getTrackTitle(track),
          lyric[0].textLanguage,
        );
      }

      const trackUrl = tagWriter.getUrl();

      /* save to chrome */
      return new Promise<void>(resolve => {
        chrome.downloads.download(
          {
            url: trackUrl,
            filename: item.downloadPath + item.filename,
          },
          () => {
            tagWriter.revokeUrl();
            resolve();
          },
        );
      });
    } catch (reason) {
      BackgroundApiService.emitError_(getExceptionError(reason));
    }
  }
  /**
   * Encodes file to filesystem friendly format by escaping banned symbols
   */
  private static encodeFilename_(filename: string): string {
    const res = filename
      .replaceAll(':', '%58')
      .replaceAll('?', '%63')
      .replaceAll('*', '%2A')
      .replaceAll('/', '%47')
      .replaceAll('\\', '%5C')
      .replaceAll('"', '%22')
      .replaceAll('|', '%124');
    return res;
  }
  /**
   * Alias for encodeFoldermame_
   */
  private static encodeFolderName_(folderName: string): string {
    return this.encodeFilename_(folderName);
  }
  /**
   * Generate filename based on provided template and args
   */
  private static generateTrackFilename_(
    template: string,
    title: string,
    album: string,
    artist: string,
  ): string {
    const filename = template
      .replaceAll('{title}', title)
      .replaceAll('{album}', album)
      .replaceAll('{artist}', artist)
      .trim();

    return this.encodeFilename_(filename);
  }

  /* API */
  /**
   * Add error listener.
   * Only errors fired in BackgroundApiService will be emitted
   */
  static on(_type: 'error', callback: ErrorCallback) {
    if (this.errorListeners_.includes(callback)) return;
    this.errorListeners_.push(callback);
  }
  /**
   * Removes error listener.
   */
  static removeListener(_type: 'error', callback: ErrorCallback) {
    const index = this.errorListeners_.indexOf(callback);
    if (index === -1) return;

    this.errorListeners_.splice(index, 1);
  }
  /**
   * Adds track to the download queue
   */
  async downloadTrack(trackId: number): Promise<void> {
    try {
      /* get track info */
      const {track} = await this.yandexMusicApi.getTrack(+trackId);

      if (!track.available) return;

      const downloadUrl =
        await this.yandexMusicApi.getTrackDownloadLink(+trackId);

      const filename = BackgroundApiService.generateTrackFilename_(
        BackgroundApiService.userSettings.filenameFormat,
        getTrackTitle(track),
        getAlbumTitle(track),
        track.artists.length > 0 ? track.artists[0].name : '',
      );

      const path = BackgroundApiService.userSettings.downloadPath;

      BackgroundApiService.downloadManager.download(
        downloadUrl,
        getTrackTitle(track),
        filename + '.mp3',
        path,
        {trackId, locale: this.yandexMusicApi.getLocale()},
      );
    } catch (reason) {
      BackgroundApiService.emitError_(getExceptionError(reason));
    }
  }
  /**
   * Download all songs from provided album
   */
  async downloadAlbum(albumId: number): Promise<void> {
    /* get album info */
    const album = await this.yandexMusicApi.getAlbum(albumId);

    let volumeIndex = 1;
    for (const volume of album.volumes) {
      for (const track of volume) {
        try {
          if (!track.available) continue;
          const downloadUrl = await this.yandexMusicApi.getTrackDownloadLink(
            +track.id,
          );

          const filename = BackgroundApiService.generateTrackFilename_(
            BackgroundApiService.userSettings.filenameFormat,
            getTrackTitle(track),
            getAlbumTitle(track),
            track.artists.length > 0 ? track.artists[0].name : '',
          );

          let path = BackgroundApiService.userSettings.downloadPath;
          if (
            BackgroundApiService.userSettings.downloadAlbumsInSeparateFolder
          ) {
            if (album.artists.length > 0) {
              path += `${BackgroundApiService.encodeFolderName_(
                album.artists[0].name,
              )}-${BackgroundApiService.encodeFolderName_(album.title)}/`;
            } else {
              path += `${BackgroundApiService.encodeFolderName_(album.title)}/`;
            }
          }
          if (album.volumes.length > 1) {
            path += `volume ${volumeIndex}/`;
          }

          BackgroundApiService.downloadManager.download(
            downloadUrl,
            getTrackTitle(track),
            filename + '.mp3',
            path,
            {trackId: track.id, locale: this.yandexMusicApi.getLocale()},
          );
        } catch (reason) {
          BackgroundApiService.emitError_(getExceptionError(reason));
        }
      }
      ++volumeIndex;
    }
  }
  /**
   * Downloads all songs from provided playlist
   */
  async downloadPlaylist(owner: string | number, kind: number): Promise<void> {
    /* get playlist info */
    const {playlist} = await this.yandexMusicApi.getPlaylist(owner, kind);

    for (const track of playlist.tracks) {
      try {
        if (!track.available) continue;
        const downloadUrl = await this.yandexMusicApi.getTrackDownloadLink(
          +track.id,
        );

        const filename = BackgroundApiService.generateTrackFilename_(
          BackgroundApiService.userSettings.filenameFormat,
          getTrackTitle(track),
          getAlbumTitle(track),
          track.artists.length > 0 ? track.artists[0].name : '',
        );

        let path = BackgroundApiService.userSettings.downloadPath;
        if (
          BackgroundApiService.userSettings.downloadPlaylistsInSeparateFolder
        ) {
          path += `${BackgroundApiService.encodeFolderName_(playlist.title)}/`;
        }

        BackgroundApiService.downloadManager.download(
          downloadUrl,
          getTrackTitle(track),
          filename + '.mp3',
          path,
          {trackId: track.id, locale: this.yandexMusicApi.getLocale()},
        );
      } catch (reason) {
        BackgroundApiService.emitError_(getExceptionError(reason));
      }
    }
  }
  /**
   * Downloads all songs of provided artist
   */
  async downloadArtist(artistId: number): Promise<void> {
    /* get artist info */
    const artist = await this.yandexMusicApi.getArtist(artistId);

    for (const trackId of artist.trackIds) {
      try {
        /* get track info */
        const {track} = await this.yandexMusicApi.getTrack(+trackId);
        if (!track.available) continue;

        const downloadUrl = await this.yandexMusicApi.getTrackDownloadLink(
          +track.id,
        );

        const filename = BackgroundApiService.generateTrackFilename_(
          BackgroundApiService.userSettings.filenameFormat,
          getTrackTitle(track),
          getAlbumTitle(track),
          track.artists.length > 0 ? track.artists[0].name : '',
        );

        let path = BackgroundApiService.userSettings.downloadPath;
        if (BackgroundApiService.userSettings.downloadArtistsInSeparateFolder) {
          path += `${BackgroundApiService.encodeFolderName_(
            artist.artist.name,
          )}/`;
        }

        BackgroundApiService.downloadManager.download(
          downloadUrl,
          getTrackTitle(track),
          filename + '.mp3',
          path,
          {trackId: track.id, locale: this.yandexMusicApi.getLocale()},
        );
      } catch (reason) {
        BackgroundApiService.emitError_(getExceptionError(reason));
      }
    }
  }
}

chrome.runtime.onConnect.addListener(async port => {
  /* `port.name` is locale */
  chrome.browserAction.setIcon({
    path: 'images/active-icon.png',
    tabId: port.sender?.tab?.id,
  });

  const addEventCallback = async (downloadItem: DownloadItem) => {
    const message: ChromeMessage = {
      type: ChromeMessageType.DOWNLOAD_EVENT,
      eventType: 'add',
      downloadItem: {
        ...downloadItem,
        bytes: null,
      },
    };

    port.postMessage(message);
  };

  const progressEventCallback = async (downloadItem: DownloadItem) => {
    const message: ChromeMessage = {
      type: ChromeMessageType.DOWNLOAD_EVENT,
      eventType: 'progress',
      downloadItem: {
        ...downloadItem,
        bytes: null,
      },
    };

    port.postMessage(message);
  };

  const interruptedEventCallback = async (downloadItem: DownloadItem) => {
    const message: ChromeMessage = {
      type: ChromeMessageType.DOWNLOAD_EVENT,
      eventType: 'interrupted',
      downloadItem: {
        ...downloadItem,
        bytes: null,
      },
    };

    port.postMessage(message);
  };

  const completeEventCallback = async (downloadItem: DownloadItem) => {
    const message: ChromeMessage = {
      type: ChromeMessageType.DOWNLOAD_EVENT,
      eventType: 'complete',
      downloadItem: {
        ...downloadItem,
        bytes: null,
      },
    };

    port.postMessage(message);
  };

  const downloadErrorEventCallback = async (
    downloadItem: DownloadItem,
    error: Error,
  ) => {
    const message: ChromeMessage = {
      type: ChromeMessageType.DOWNLOAD_ERROR_EVENT,
      downloadItem: {
        ...downloadItem,
        bytes: null,
      },
      error,
    };

    port.postMessage(message);
  };

  const errorEventCallback = (error: Error) => {
    const message: ChromeMessage = {
      type: ChromeMessageType.ERROR_EVENT,
      error,
    };

    port.postMessage(message);
  };

  const backgroundApi = await BackgroundApiService.getInstance(port.name);
  port.onMessage.addListener((message: ChromeMessage) => {
    switch (message.type) {
      case ChromeMessageType.ADD_DOWNLOAD_LISTENER: {
        BackgroundApiService.downloadManager.on('add', addEventCallback);
        BackgroundApiService.downloadManager.on(
          'progress',
          progressEventCallback,
        );
        BackgroundApiService.downloadManager.on(
          'interrupted',
          interruptedEventCallback,
        );
        BackgroundApiService.downloadManager.on(
          'complete',
          completeEventCallback,
        );
        break;
      }
      case ChromeMessageType.ADD_ERROR_LISTENER: {
        BackgroundApiService.downloadManager.on(
          'error',
          downloadErrorEventCallback,
        );
        BackgroundApiService.on('error', errorEventCallback);
        break;
      }
      case ChromeMessageType.DOWNLOAD_TRACK: {
        void backgroundApi.downloadTrack(message.trackId);
        break;
      }
      case ChromeMessageType.DOWNLOAD_ALBUM: {
        void backgroundApi.downloadAlbum(message.albumId);
        break;
      }
      case ChromeMessageType.DOWNLOAD_PLAYLIST: {
        void backgroundApi.downloadPlaylist(message.owner, message.kind);
        break;
      }
      case ChromeMessageType.DOWNLOAD_ARTIST: {
        void backgroundApi.downloadArtist(message.artistId);
        break;
      }
      case ChromeMessageType.LIST_DOWNLOAD_ITEMS: {
        const message: ChromeMessage = {
          type: ChromeMessageType.LIST_DOWNLOAD_ITEMS,
          items: BackgroundApiService.downloadManager.list().map(item => {
            return {...item, bytes: null};
          }),
        };

        port.postMessage(message);
        break;
      }
      case ChromeMessageType.INTERRUPT_DOWNLOAD: {
        BackgroundApiService.downloadManager.interrupt(message.downloadItemId);
        break;
      }
      default: {
        console.debug('Unknown message type: ' + message.type);
        break;
      }
    }
  });

  port.onDisconnect.addListener(() => {
    /* Remove registered hooks */
    BackgroundApiService.downloadManager.removeListener(
      'add',
      addEventCallback,
    );
    BackgroundApiService.downloadManager.removeListener(
      'progress',
      progressEventCallback,
    );
    BackgroundApiService.downloadManager.removeListener(
      'interrupted',
      interruptedEventCallback,
    );
    BackgroundApiService.downloadManager.removeListener(
      'complete',
      completeEventCallback,
    );
    /* Remove registered error listeners */
    BackgroundApiService.downloadManager.removeListener(
      'error',
      downloadErrorEventCallback,
    );
    BackgroundApiService.removeListener('error', errorEventCallback);
  });
});
