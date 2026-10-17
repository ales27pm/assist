#import "RCTNativeAssist.h"
// Assist-Swift.h also exports ReactNativeDelegate; its superclass must be known
// when this Objective-C++ translation unit imports the generated Swift header.
#import <React-RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h>
// AssistVoice exposes this protocol through the generated Swift header.
#import <AVFoundation/AVFoundation.h>
#import <UIKit/UIKit.h>
#import "Assist-Swift.h"

typedef void (^AssistCompletion)(NSString *_Nullable, NSError *_Nullable);

static void AssistReject(RCTPromiseRejectBlock reject, NSError *error) {
  NSString *code = [error.userInfo[@"code"] isKindOfClass:NSString.class]
    ? error.userInfo[@"code"] : @"E_NATIVE";
  reject(code, error.localizedDescription, error);
}

static NSError *AssistError(NSString *code, NSString *message) {
  return [NSError errorWithDomain:@"Assist.TurboModule" code:1
                        userInfo:@{ @"code": code, NSLocalizedDescriptionKey: message }];
}

// The resource location is fixed by the app; JavaScript cannot choose a path.
// Presence is not a qualification claim: the engine still validates and loads
// the complete export, tokenizer, and graph contract before becoming ready.
static NSURL *AssistBundledModelURL(void) {
  NSURL *root = [NSBundle.mainBundle.resourceURL URLByAppendingPathComponent:@"BundledModels/Gemma"
                                                               isDirectory:YES];
  NSURL *metadata = [root URLByAppendingPathComponent:@"metadata.json" isDirectory:NO];
  NSNumber *regularFile = nil;
  if (![metadata getResourceValue:&regularFile forKey:NSURLIsRegularFileKey error:nil] ||
      !regularFile.boolValue || ![NSFileManager.defaultManager isReadableFileAtPath:metadata.path]) {
    return nil;
  }
  return root;
}

// Engine callbacks may arrive on any executor. Promise settlement and adapter
// lifecycle bookkeeping are serialized on main; inference remains in Swift.
static AssistCompletion AssistPromise(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
  __block BOOL settled = NO;
  return ^(NSString *result, NSError *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (settled) { return; }
      settled = YES;
      if (error) {
        AssistReject(reject, error);
      } else if (result) {
        resolve(result);
      } else {
        AssistReject(reject, AssistError(@"E_NATIVE_RESULT", @"Réponse native absente."));
      }
    });
  };
}

@implementation RCTNativeAssist {
  AssistCoreAI *_engine;
  AssistModelDirectoryPicker *_picker;
  AssistVoice *_voice;
  NSString *_operation;
  BOOL _loaded;
  BOOL _invalidated;
  BOOL _cleanupStarted;
  NSUInteger _cancellationsInFlight;
}

+ (NSString *)moduleName { return @"NativeAssist"; }

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeAssistSpecJSI>(params);
}

- (BOOL)prepare:(RCTPromiseRejectBlock)reject {
  NSAssert(NSThread.isMainThread, @"Adapter coordination must run on main.");
  if (_invalidated) {
    AssistReject(reject, AssistError(@"E_INVALIDATED", @"Le module a été fermé."));
    return NO;
  }
  if (!_engine) { _engine = [AssistCoreAI new]; }
  if (!_picker) { _picker = [AssistModelDirectoryPicker new]; }
  return YES;
}

- (NSString *)beginOperation:(RCTPromiseRejectBlock)reject {
  if (![self prepare:reject]) { return nil; }
  if (_operation || _cancellationsInFlight > 0) {
    AssistReject(reject, AssistError(@"E_BUSY", @"Une opération est déjà en cours."));
    return nil;
  }
  _operation = NSUUID.UUID.UUIDString;
  return _operation;
}

// Voice has its own lifecycle: recording and playback must remain stoppable
// while the language engine is generating or cancelling.
- (BOOL)prepareVoice:(RCTPromiseRejectBlock)reject {
  if (![self prepare:reject]) { return NO; }
  if (!_voice) {
    _voice = [AssistVoice new];
    __weak RCTNativeAssist *weakSelf = self;
    [_voice setEventHandler:^(NSString *json) {
      RCTNativeAssist *strongSelf = weakSelf;
      if (!strongSelf || strongSelf->_invalidated) { return; }
      [strongSelf emitOnVoiceEvent:@{ @"json": json }];
    }];
  }
  return YES;
}

- (void)getVoiceStatus:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![self prepareVoice:reject]) { return; }
    [self->_voice status:AssistPromise(resolve, reject)];
  });
}

- (void)getSpeechVoices:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![self prepareVoice:reject]) { return; }
    [self->_voice getSpeechVoices:AssistPromise(resolve, reject)];
  });
}

- (void)getAdvancedVoiceState:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![self prepareVoice:reject]) { return; }
    [[AssistAdvancedVoiceResources shared] status:AssistPromise(resolve, reject)];
  });
}

- (BOOL)canChangeAdvancedVoiceResources:(RCTPromiseRejectBlock)reject {
  if (![self prepareVoice:reject]) { return NO; }
  if (![self->_voice canChangeAdvancedVoiceResources]) {
    AssistReject(reject, AssistError(@"E_VOICE_BUSY", @"Ferme le mode vocal et la lecture avant de modifier ses ressources."));
    return NO;
  }
  return YES;
}

- (void)withAdvancedVoiceResourcesReleased:(void (^)(void))action reject:(RCTPromiseRejectBlock)reject {
  if (![self canChangeAdvancedVoiceResources:reject]) { return; }
  // Swift closes admission before awaiting Core ML cleanup. The callback runs
  // synchronously on main while that barrier remains held; import then claims
  // the resources owner's busy flag before a new microphone can start.
  [self->_voice releaseAdvancedVoiceRuntime:^(BOOL released) {
    if (self->_invalidated) {
      AssistReject(reject, AssistError(@"E_INVALIDATED", @"Le module a été fermé."));
    } else if (!released) {
      AssistReject(reject, AssistError(@"E_VOICE_BUSY", @"L’arrêt du moteur vocal n’est pas confirmé."));
    } else {
      action();
    }
  }];
}

- (void)importAdvancedVoicePack:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    [self withAdvancedVoiceResourcesReleased:^{
      [[AssistAdvancedVoiceResources shared] importPack:AssistPromise(resolve, reject)];
    } reject:reject];
  });
}

- (void)setAdvancedVoiceBackend:(NSString *)backend variant:(NSString *)variant
                       resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    [self withAdvancedVoiceResourcesReleased:^{
      [[AssistAdvancedVoiceResources shared] setBackend:backend variant:variant completion:AssistPromise(resolve, reject)];
    } reject:reject];
  });
}

- (void)setSpeechVoice:(NSString *)voiceId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![self prepareVoice:reject]) { return; }
    [self->_voice setSpeechVoice:voiceId completion:AssistPromise(resolve, reject)];
  });
}

- (void)previewSpeechVoice:(NSString *)voiceId segmentsJSON:(NSString *)segmentsJSON sessionId:(NSString *)sessionId
                  resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![self prepareVoice:reject]) { return; }
    [self->_voice previewSpeechVoice:voiceId segmentsJSON:segmentsJSON sessionId:sessionId completion:AssistPromise(resolve, reject)];
  });
}

- (void)stopSpeechVoicePreview:(NSString *)sessionId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![self prepareVoice:reject]) { return; }
    [self->_voice stopSpeechVoicePreview:sessionId completion:AssistPromise(resolve, reject)];
  });
}

- (void)getVoicePreferences:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![self prepareVoice:reject]) { return; }
    [self->_voice getVoicePreferences:AssistPromise(resolve, reject)];
  });
}

- (void)setVoicePreferences:(BOOL)readResponses resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![self prepareVoice:reject]) { return; }
    [self->_voice setVoicePreferences:readResponses completion:AssistPromise(resolve, reject)];
  });
}

- (void)startListening:(NSString *)sessionId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![self prepareVoice:reject]) { return; }
    [self->_voice startListening:sessionId completion:AssistPromise(resolve, reject)];
  });
}

- (void)stopListening:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![self prepareVoice:reject]) { return; }
    [self->_voice stopListening:AssistPromise(resolve, reject)];
  });
}

- (void)cancelVoice:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![self prepareVoice:reject]) { return; }
    [self->_voice cancel:AssistPromise(resolve, reject)];
  });
}

- (void)speak:(NSString *)text utteranceId:(NSString *)utteranceId
      resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![self prepareVoice:reject]) { return; }
    [self->_voice speak:text utteranceId:utteranceId completion:AssistPromise(resolve, reject)];
  });
}

- (void)beginSpeech:(NSString *)utteranceId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![self prepareVoice:reject]) { return; }
    [self->_voice beginSpeech:utteranceId completion:AssistPromise(resolve, reject)];
  });
}

- (void)enqueueSpeech:(NSString *)text utteranceId:(NSString *)utteranceId
              resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![self prepareVoice:reject]) { return; }
    [self->_voice enqueueSpeech:text utteranceId:utteranceId completion:AssistPromise(resolve, reject)];
  });
}

- (void)finishSpeech:(NSString *)utteranceId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![self prepareVoice:reject]) { return; }
    [self->_voice finishSpeech:utteranceId completion:AssistPromise(resolve, reject)];
  });
}

- (AssistCompletion)refreshResidentStateOnFailure:(AssistCompletion)completion {
  return ^(NSString *result, NSError *error) {
    if (!error) { completion(result, nil); return; }
    [self->_engine status:^(NSString *status, NSError *statusError) {
      dispatch_async(dispatch_get_main_queue(), ^{
        if (status && !statusError) {
          NSData *data = [status dataUsingEncoding:NSUTF8StringEncoding];
          id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
          if ([value isKindOfClass:NSDictionary.class]) {
            self->_loaded = [value[@"modelName"] isKindOfClass:NSString.class];
            if (!self->_loaded) { [self->_picker releaseAccess]; }
          }
        }
        completion(nil, error);
      });
    }];
  };
}

- (AssistCompletion)completionForOperation:(NSString *)operation
                                  resolve:(RCTPromiseResolveBlock)resolve
                                   reject:(RCTPromiseRejectBlock)reject
                                  cleanup:(void (^)(BOOL))cleanup {
  __block BOOL settled = NO;
  return ^(NSString *result, NSError *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (settled) { return; }
      settled = YES;
      BOOL succeeded = result != nil && error == nil;
      cleanup(succeeded);
      if ([self->_operation isEqualToString:operation]) { self->_operation = nil; }
      if (self->_invalidated) {
        AssistReject(reject, AssistError(@"E_INVALIDATED", @"Le module a été fermé."));
      } else if (error) {
        AssistReject(reject, error);
      } else if (result) {
        resolve(result);
      } else {
        AssistReject(reject, AssistError(@"E_NATIVE_RESULT", @"Réponse native absente."));
      }
      [self cleanupIfInvalidated];
    });
  };
}

- (void)getStatus:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![self prepare:reject]) { return; }
    AssistCompletion completion = AssistPromise(resolve, reject);
    [self->_engine status:^(NSString *result, NSError *error) {
      if (error || !result) { completion(result, error); return; }
      NSData *data = [result dataUsingEncoding:NSUTF8StringEncoding];
      NSError *serializationError = nil;
      id value = [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingMutableContainers
                                                 error:&serializationError];
      if (![value isKindOfClass:NSMutableDictionary.class]) {
        completion(nil, serializationError ?: AssistError(@"E_NATIVE_RESULT", @"État natif invalide."));
        return;
      }
      value[@"bundledModelAvailable"] = @(AssistBundledModelURL() != nil);
      dispatch_async(dispatch_get_main_queue(), ^{
        if (self->_invalidated) {
          completion(nil, AssistError(@"E_INVALIDATED", @"Le module a été fermé."));
          return;
        }
        [self->_picker selectionStatus:^(NSDictionary *selection) {
          if (self->_invalidated) {
            completion(nil, AssistError(@"E_INVALIDATED", @"Le module a été fermé."));
            return;
          }
          [value addEntriesFromDictionary:selection];
          NSError *decorationError = nil;
          NSData *augmented = [NSJSONSerialization dataWithJSONObject:value options:0 error:&decorationError];
          completion(augmented ? [[NSString alloc] initWithData:augmented encoding:NSUTF8StringEncoding] : nil,
                     decorationError);
        }];
      });
    }];
  });
}

- (void)getMonitoringSnapshot:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![self prepare:reject]) { return; }
    // Read-only telemetry has its own actor and remains available while the
    // inference adapter holds its load/generation/diagnostic operation gate.
    [self->_engine monitoringSnapshot:AssistPromise(resolve, reject)];
  });
}

- (void)selectModel:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![self prepare:reject]) { return; }
    if (self->_loaded) {
      AssistReject(reject, AssistError(@"E_MODEL_LOADED", @"Décharge le modèle avant d’en sélectionner un autre."));
      return;
    }
    NSString *operation = [self beginOperation:reject];
    if (!operation) { return; }
    AssistCompletion completion = [self completionForOperation:operation resolve:resolve reject:reject
                                                     cleanup:^(BOOL succeeded) {}];
    [self->_picker selectWithCompletion:^(NSString *name, NSError *error) {
      if (error || !name) { completion(nil, error); return; }
      NSError *serializationError = nil;
      NSData *data = [NSJSONSerialization dataWithJSONObject:@{ @"modelName": name, @"phase": @"selected" }
                                                     options:0 error:&serializationError];
      completion(data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil,
                 serializationError);
    }];
  });
}

- (void)loadModel:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![self prepare:reject]) { return; }
    if (self->_loaded) {
      AssistReject(reject, AssistError(@"E_MODEL_LOADED", @"Le modèle est déjà chargé."));
      return;
    }
    NSString *operation = [self beginOperation:reject];
    if (!operation) { return; }
    AssistCompletion completion = [self completionForOperation:operation resolve:resolve reject:reject
                                                     cleanup:^(BOOL succeeded) {
      self->_loaded = succeeded;
      if (!succeeded) { [self->_picker releaseAccess]; }
    }];
    [self->_picker withSelectedPath:^(NSString *path, NSError *error) {
      if (error || !path) { completion(nil, error); return; }
      [self->_engine load:path completion:completion];
    }];
  });
}

- (void)loadBundledModel:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![self prepare:reject]) { return; }
    if (self->_loaded) {
      AssistReject(reject, AssistError(@"E_MODEL_LOADED", @"Le modèle est déjà chargé."));
      return;
    }
    NSString *operation = [self beginOperation:reject];
    if (!operation) { return; }
    AssistCompletion completion = [self completionForOperation:operation resolve:resolve reject:reject
                                                     cleanup:^(BOOL succeeded) {
      self->_loaded = succeeded;
      if (!succeeded) { [self->_picker releaseAccess]; }
    }];
    NSURL *modelURL = AssistBundledModelURL();
    if (!modelURL) {
      completion(nil, AssistError(@"E_BUNDLED_MODEL_MISSING", @"Gemma n’est pas intégré à cette build."));
      return;
    }
    [self->_picker releaseAccess];
    [self->_engine load:modelURL.path completion:completion];
  });
}

- (void)runNumericalProbe:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![self prepare:reject]) { return; }
    if (self->_loaded) {
      AssistReject(reject, AssistError(@"E_MODEL_LOADED", @"Décharge le modèle avant le diagnostic de calcul."));
      return;
    }
    NSString *operation = [self beginOperation:reject];
    if (!operation) { return; }
    [self->_engine runNumericalProbe:[self completionForOperation:operation resolve:resolve reject:reject
                                                      cleanup:^(BOOL succeeded) {}]];
  });
}

- (void)getLastModelLoadProbe:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![self prepare:reject]) { return; }
    [self->_engine lastModelLoadProbe:AssistPromise(resolve, reject)];
  });
}

- (void)getLastSpecializationRepair:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![self prepare:reject]) { return; }
    [self->_engine lastSpecializationRepair:AssistPromise(resolve, reject)];
  });
}

- (void)repairNumericalProbe:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![self prepare:reject]) { return; }
    if (self->_loaded) {
      AssistReject(reject, AssistError(@"E_MODEL_LOADED", @"Décharge le modèle avant de réparer sa préparation."));
      return;
    }
    NSString *operation = [self beginOperation:reject];
    if (!operation) { return; }
    [self->_engine repairNumericalProbe:[self completionForOperation:operation resolve:resolve reject:reject
                                                         cleanup:^(BOOL succeeded) {}]];
  });
}

- (void)repairModelLoadProbe:(NSString *)functionName
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![self prepare:reject]) { return; }
    if (self->_loaded) {
      AssistReject(reject, AssistError(@"E_MODEL_LOADED", @"Décharge le modèle avant de réparer sa préparation."));
      return;
    }
    NSString *operation = [self beginOperation:reject];
    if (!operation) { return; }
    AssistCompletion completion = [self completionForOperation:operation resolve:resolve reject:reject
                                                     cleanup:^(BOOL succeeded) {
      [self->_picker releaseAccess];
    }];
    [self->_picker withSelectedPath:^(NSString *path, NSError *error) {
      if (error || !path) { completion(nil, error); return; }
      [self->_engine repairModelLoadProbe:path functionName:functionName completion:completion];
    }];
  });
}

- (void)getLastModelAssetProbe:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![self prepare:reject]) { return; }
    [self->_engine lastModelAssetProbe:AssistPromise(resolve, reject)];
  });
}

- (void)runModelAssetProbe:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![self prepare:reject]) { return; }
    if (self->_loaded) {
      AssistReject(reject, AssistError(@"E_MODEL_LOADED", @"Décharge le modèle avant de vérifier ses fichiers."));
      return;
    }
    NSString *operation = [self beginOperation:reject];
    if (!operation) { return; }
    AssistCompletion completion = [self completionForOperation:operation resolve:resolve reject:reject
                                                     cleanup:^(BOOL succeeded) {
      [self->_picker releaseAccess];
    }];
    [self->_picker withSelectedPath:^(NSString *path, NSError *error) {
      if (error || !path) { completion(nil, error); return; }
      [self->_engine runModelAssetProbe:path completion:completion];
    }];
  });
}

- (void)runModelLoadProbe:(NSString *)functionName
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![self prepare:reject]) { return; }
    if (self->_loaded) {
      AssistReject(reject, AssistError(@"E_MODEL_LOADED", @"Décharge le modèle avant le diagnostic de chargement."));
      return;
    }
    NSString *operation = [self beginOperation:reject];
    if (!operation) { return; }
    AssistCompletion completion = [self completionForOperation:operation resolve:resolve reject:reject
                                                     cleanup:^(BOOL succeeded) {
      [self->_picker releaseAccess];
    }];
    [self->_picker withSelectedPath:^(NSString *path, NSError *error) {
      if (error || !path) { completion(nil, error); return; }
      [self->_engine runModelLoadProbe:path functionName:functionName completion:completion];
    }];
  });
}

- (void)generate:(NSString *)requestJSON
         resolve:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    NSString *operation = [self beginOperation:reject];
    if (!operation) { return; }
    AssistCompletion completion = [self completionForOperation:operation resolve:resolve reject:reject
                                                     cleanup:^(BOOL succeeded) {}];
    __weak RCTNativeAssist *weakSelf = self;
    [self->_engine generate:requestJSON onProgress:^(NSString *json) {
      dispatch_async(dispatch_get_main_queue(), ^{
        RCTNativeAssist *strongSelf = weakSelf;
        if (!strongSelf || strongSelf->_invalidated ||
            ![strongSelf->_operation isEqualToString:operation]) { return; }
        [strongSelf emitOnProgress:@{ @"json": json }];
      });
    } completion:[self refreshResidentStateOnFailure:completion]];
  });
}

- (void)cancelEngineWithCompletion:(AssistCompletion)completion {
  _cancellationsInFlight += 1;
  __block BOOL settled = NO;
  [_engine cancel:^(NSString *result, NSError *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (settled) { return; }
      settled = YES;
      self->_cancellationsInFlight -= 1;
      completion(result, error);
      [self cleanupIfInvalidated];
    });
  }];
}

- (void)cancel:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![self prepare:reject]) { return; }
    // Cancellation must bypass the busy gate; the original operation still
    // owns completion and directory access until it actually finishes.
    [self cancelEngineWithCompletion:AssistPromise(resolve, reject)];
  });
}

- (void)reset:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    NSString *operation = [self beginOperation:reject];
    if (!operation) { return; }
    AssistCompletion completion = [self completionForOperation:operation resolve:resolve reject:reject
                                                     cleanup:^(BOOL succeeded) {}];
    [self->_engine reset:[self refreshResidentStateOnFailure:completion]];
  });
}

- (void)unloadModel:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    NSString *operation = [self beginOperation:reject];
    if (!operation) { return; }
    [self->_engine unload:[self completionForOperation:operation resolve:resolve reject:reject
                                               cleanup:^(BOOL succeeded) {
      if (succeeded) {
        self->_loaded = NO;
        [self->_picker releaseAccess];
      }
    }]];
  });
}

- (void)cleanupIfInvalidated {
  if (!_invalidated || _operation || _cancellationsInFlight > 0 || _cleanupStarted) { return; }
  _cleanupStarted = YES;
  AssistModelDirectoryPicker *picker = _picker;
  if (!_engine) { [picker invalidate]; return; }
  // Called only after accepted work completes, so scope is not revoked while
  // the runtime still reads the model directory.
  [_engine unload:^(NSString *result, NSError *error) {
    dispatch_async(dispatch_get_main_queue(), ^{ [picker invalidate]; });
  }];
}

- (void)invalidate {
  dispatch_async(dispatch_get_main_queue(), ^{
    self->_invalidated = YES;
    [[AssistAdvancedVoiceResources shared] cancelImports];
    [self->_voice invalidate];
    [self->_engine shutdownMonitoring:^(NSString *result, NSError *error) {}];
    if (!self->_loaded) {
      // If selection is open this settles it; never release a loading model's
      // directory before its completion. Picker cancellation is handled below.
      // An active picker has no model IO; the picker provides a narrow cancel.
      [self->_picker cancelSelection];
    }
    if (self->_engine) {
      [self cancelEngineWithCompletion:^(NSString *result, NSError *error) {}];
    }
    [self cleanupIfInvalidated];
  });
}

@end
