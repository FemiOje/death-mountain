import { fetchAdventurer } from '@/api/starknet';
import { getSettingsList, Settings } from '@/dojo/useGameSettings';
import { fetchMetadata } from '@/dojo/useGameTokens';
import { useSystemCalls } from '@/dojo/useSystemCalls';
import { useGameStore } from '@/stores/gameStore';
import { GameAction, getEntityModel } from '@/types/game';
import { BattleEvents, ExplorerLogEvents, ExplorerReplayEvents, formatGameEvent, GameEvent } from '@/utils/events';
import { getNewItemsEquipped } from '@/utils/game';
import { gameEventsQuery } from '@/utils/queries';
import { delay } from '@/utils/utils';
import { useDojoSDK } from '@dojoengine/sdk/react';
import { createContext, PropsWithChildren, useContext, useEffect, useReducer, useState } from 'react';
import { useNavigate } from 'react-router-dom';

export interface GameDirectorContext {
  executeGameAction: (action: GameAction) => void;
  actionFailed: number;
  subscription: any;
  watch: {
    setSpectating: (spectating: boolean) => void;
    spectating: boolean;
    replayEvents: any[];
    processEvent: (event: any, reconnecting: boolean) => void;
    setEventQueue: (events: any[]) => void;
  }
}

const GameDirectorContext = createContext<GameDirectorContext>({} as GameDirectorContext);

/**
 * Wait times for events in milliseconds
*/
const delayTimes: any = {
  'level_up': 1000,
  'discovery': 1000,
  'obstacle': 1000,
  'attack': 2000,
  'beast_attack': 2000,
  'flee': 1000,
}

const replayDelayTimes: any = {
  'level_up': 1000,
  'discovery': 1000,
  'obstacle': 1000,
  'attack': 2000,
  'beast_attack': 2000,
  'flee': 1000,
  'fled_beast': 1000,
  'defeated_beast': 1000,
  'stat_upgrade': 1000,
  'buy_items': 1000,
  'equip': 1000,
  'drop': 1000,
}

const VRF_ENABLED = true;

export const GameDirector = ({ children }: PropsWithChildren) => {
  const navigate = useNavigate();
  const { sdk } = useDojoSDK();
  const { startGame, executeAction, requestRandom, explore, attack,
    flee, buyItems, selectStatUpgrades, equip, drop } = useSystemCalls();

  const { gameId, adventurer, adventurerState, setAdventurer, setBag, setBeast, setExploreLog, setBattleEvent, newInventoryItems,
    setMarketItemIds, setNewMarket, setNewInventoryItems, metadata, gameSettings, setGameSettings } = useGameStore();

  const [spectating, setSpectating] = useState(false);
  const [replayEvents, setReplayEvents] = useState<GameEvent[]>([]);
  const [VRFEnabled, setVRFEnabled] = useState(VRF_ENABLED);

  const [subscription, setSubscription] = useState<any>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [eventQueue, setEventQueue] = useState<GameEvent[]>([]);
  const [actionFailed, setActionFailed] = useReducer(x => x + 1, 0);

  useEffect(() => {
    if (gameId) {
      fetchMetadata(sdk, gameId);
    }
  }, [gameId]);

  useEffect(() => {
    if (gameId && metadata && !gameSettings) {
      getSettingsList(null, [metadata.settings_id]).then((settings: Settings[]) => {
        setGameSettings(settings[0])
        setVRFEnabled(settings[0].game_seed === 0);
        subscribeEvents(gameId!, settings[0]);
      })
    }
  }, [metadata, gameId]);

  useEffect(() => {
    const processNextEvent = async () => {
      if (eventQueue.length > 0 && !isProcessing) {
        setIsProcessing(true);
        const event = eventQueue[0];
        await processEvent(event, false);
        setEventQueue(prev => prev.slice(1));
        setIsProcessing(false);
      }
    };

    processNextEvent();
  }, [eventQueue, isProcessing]);

  const subscribeEvents = async (gameId: number, settings: Settings) => {
    if (subscription) {
      subscription.cancel();
    }

    const [initialData, sub] = await sdk.subscribeEventQuery({
      query: gameEventsQuery(gameId),
      callback: ({ data, error }: { data?: any[]; error?: Error }) => {
        if (data && data.length > 0) {
          let events = data.filter((entity: any) => Boolean(getEntityModel(entity, "GameEvent")))
            .map((entity: any) => formatGameEvent(entity));

          setEventQueue(prev => [...prev, ...events]);
        }
      }
    });

    let events = (initialData?.getItems() || [])
      .filter((entity: any) => Boolean(getEntityModel(entity, "GameEvent")))
      .map((entity: any) => formatGameEvent(entity))
      .sort((a: GameEvent, b: GameEvent) => a.action_count - b.action_count);

    if (spectating) {
      handleSpectating(events);
    } else if (!events || events.length === 0) {
      startGame(gameId, (settings.game_seed === 0 && settings.adventurer.xp !== 0));
    } else {
      reconnectGameEvents(events);
    }

    setSubscription(sub);
  }

  const handleSpectating = async (events: GameEvent[]) => {
    if (events.length === 0) {
      return navigate('/');
    }

    // Fetch adventurer state
    const adventurer = await fetchAdventurer(gameId!);
    if (!adventurer) {
      return navigate('/');
    }

    if (adventurer.health > 0) {
      reconnectGameEvents(events);
    } else {
      setReplayEvents(events);
    }
  }

  const reconnectGameEvents = async (events: GameEvent[]) => {
    events.forEach(event => {
      processEvent(event, true);
    });
  }

  const processEvent = async (event: GameEvent, reconnecting: boolean) => {
    if (event.type === 'adventurer') {
      setAdventurer(event.adventurer!);
    }

    if (event.type === 'bag') {
      setBag(event.bag!.filter((item: any) => typeof item === 'object' && item.id !== 0));
    }

    if (event.type === 'beast') {
      setBeast(event.beast!);
    }

    if (event.type === 'market_items') {
      setMarketItemIds(event.items!);
      setNewMarket(true);
    }

    if (!spectating && ExplorerLogEvents.includes(event.type)) {
      if (!reconnecting && event.type === 'discovery') {
        if (event.discovery?.type === 'Loot') {
          setNewInventoryItems([...newInventoryItems, event.discovery.amount!]);
        }
      }

      setExploreLog(event);
    }

    if (spectating && ExplorerReplayEvents.includes(event.type)) {
      setExploreLog(event);
    }

    if (!reconnecting && BattleEvents.includes(event.type)) {
      setBattleEvent(event);
    }

    if (!reconnecting && (delayTimes[event.type] || replayDelayTimes[event.type])) {
      await delay(reconnecting ? replayDelayTimes[event.type] : delayTimes[event.type]);
    }
  }

  const executeGameAction = (action: GameAction) => {
    if (spectating) return;

    let txs: any[] = [];

    if (VRFEnabled && ['explore', 'attack', 'flee'].includes(action.type)) {
      txs.push(requestRandom());
    }

    if (VRFEnabled && action.type === 'equip' && adventurer?.beast_health! > 0) {
      txs.push(requestRandom());
    }

    let newItemsEquipped = getNewItemsEquipped(adventurer?.equipment!, adventurerState?.equipment!);
    if (action.type !== 'equip' && newItemsEquipped.length > 0) {
      txs.push(equip(gameId!, newItemsEquipped.map(item => item.id)));
    }

    if (action.type === 'explore') {
      txs.push(explore(gameId!, action.untilBeast!));
    } else if (action.type === 'attack') {
      txs.push(attack(gameId!, action.untilDeath!));
    } else if (action.type === 'flee') {
      txs.push(flee(gameId!, action.untilDeath!));
    } else if (action.type === 'buy_items') {
      txs.push(buyItems(gameId!, action.potions!, action.itemPurchases!));
    } else if (action.type === 'select_stat_upgrades') {
      txs.push(selectStatUpgrades(gameId!, action.statUpgrades!));
    } else if (action.type === 'equip') {
      txs.push(equip(gameId!, newItemsEquipped.map(item => item.id)));
    } else if (action.type === 'drop') {
      txs.push(drop(gameId!, action.items!));
    }

    executeAction(txs, setActionFailed);
  }

  return (
    <GameDirectorContext.Provider value={{
      executeGameAction,
      actionFailed,
      subscription,

      watch: {
        setSpectating,
        spectating,
        replayEvents,
        processEvent,
        setEventQueue
      }
    }}>
      {children}
    </GameDirectorContext.Provider>
  );
};

export const useGameDirector = () => {
  return useContext(GameDirectorContext);
};

