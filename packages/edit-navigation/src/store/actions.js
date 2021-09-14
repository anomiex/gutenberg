/**
 * External dependencies
 */
import { zip } from 'lodash';

/**
 * WordPress dependencies
 */
import { __, sprintf } from '@wordpress/i18n';
import { store as noticesStore } from '@wordpress/notices';
import { store as coreDataStore } from '@wordpress/core-data';
import apiFetch from '@wordpress/api-fetch';

/**
 * Internal dependencies
 */
import { STORE_NAME } from './constants';
import { NAVIGATION_POST_KIND, NAVIGATION_POST_POST_TYPE } from '../constants';
import { menuItemsQuery } from './utils';
import { blockToMenuItem } from './transform';

/**
 * Returns an action object used to select menu.
 *
 * @param {number} menuId The menu ID.
 * @return {Object} Action object.
 */
export function setSelectedMenuId( menuId ) {
	return {
		type: 'SET_SELECTED_MENU_ID',
		menuId,
	};
}

/**
 * Creates a menu item for every block that doesn't have an associated menuItem.
 * Requests POST /wp/v2/menu-items once for every menu item created.
 *
 * @param {Object} post A navigation post to process
 * @return {Function} An action creator
 */
export const createMissingMenuItems = ( post ) => async ( {
	dispatch,
	registry,
} ) => {
	const menuId = post.meta.menuId;
	// @TODO: extract locks to a separate package?
	const lock = await registry
		.dispatch( coreDataStore )
		.__unstableAcquireStoreLock( STORE_NAME, [ 'savingMenu' ], {
			exclusive: false,
		} );
	try {
		// Ensure all the menu items are available before we start creating placeholders.
		await registry
			.resolveSelect( coreDataStore )
			.getMenuItems( { menus: menuId, per_page: -1 } );

		const menuItemIdToBlockId = await dispatch(
			getEntityRecordIdToBlockIdMapping( post.id )
		);
		const knownBlockIds = new Set( Object.values( menuItemIdToBlockId ) );

		const blocks = blocksTreeToFlatList( post.blocks[ 0 ].innerBlocks );
		for ( const { block } of blocks ) {
			if ( ! knownBlockIds.has( block.clientId ) ) {
				const menuItem = await dispatch(
					createPlaceholderMenuItem( block, menuId )
				);
				menuItemIdToBlockId[ menuItem.id ] = block.clientId;
			}
		}

		dispatch( {
			type: 'SET_MENU_ITEM_TO_CLIENT_ID_MAPPING',
			postId: post.id,
			mapping: menuItemIdToBlockId,
		} );
	} finally {
		registry.dispatch( coreDataStore ).__unstableReleaseStoreLock( lock );
	}
};

export const createPlaceholderMenuItem = ( block, menuId ) => async ( {
	registry,
} ) => {
	const menuItem = await apiFetch( {
		path: `/__experimental/menu-items`,
		method: 'POST',
		data: {
			title: 'Placeholder',
			url: 'Placeholder',
			menu_order: 1,
		},
	} );

	const menuItems = await registry
		.select( coreDataStore )
		.getMenuItems( { menus: menuId, per_page: -1 } );

	await registry
		.dispatch( coreDataStore )
		.receiveEntityRecords(
			'root',
			'menuItem',
			[ ...menuItems, menuItem ],
			menuItemsQuery( menuId ),
			false
		);

	return menuItem;
};

/**
 * Converts all the blocks into menu items and submits a batch request to save everything at once.
 *
 * @param {Object} post A navigation post to process
 * @return {Function} An action creator
 */
export const saveNavigationPost = ( post ) => async ( {
	registry,
	dispatch,
} ) => {
	const lock = await registry
		.dispatch( coreDataStore )
		.__unstableAcquireStoreLock( STORE_NAME, [ 'savingMenu' ], {
			exclusive: true,
		} );
	try {
		const menuId = post.meta.menuId;

		await registry
			.dispatch( coreDataStore )
			.saveEditedEntityRecord( 'root', 'menu', menuId );

		const error = registry
			.select( coreDataStore )
			.getLastEntitySaveError( 'root', 'menu', menuId );

		if ( error ) {
			throw new Error( error.message );
		}

		// Batch save menu items
		const oldMenuItems = await registry
			.resolveSelect( coreDataStore )
			.getMenuItems( { menus: post.meta.menuId, per_page: -1 } );

		const desiredMenuItems = dispatch(
			getDesiredMenuItems( post, oldMenuItems )
		);
		await dispatch(
			batchSaveChanges(
				'root',
				'menuItem',
				oldMenuItems,
				desiredMenuItems
			)
		);

		// Clear "stub" navigation post edits to avoid a false "dirty" state.
		await registry
			.dispatch( coreDataStore )
			.receiveEntityRecords(
				NAVIGATION_POST_KIND,
				NAVIGATION_POST_POST_TYPE,
				[ post ],
				undefined
			);

		registry
			.dispatch( noticesStore )
			.createSuccessNotice( __( 'Navigation saved.' ), {
				type: 'snackbar',
			} );
	} catch ( saveError ) {
		const errorMessage = saveError
			? sprintf(
					/* translators: %s: The text of an error message (potentially untranslated). */
					__( "Unable to save: '%s'" ),
					saveError.message
			  )
			: __( 'Unable to save: An error o1curred.' );
		registry.dispatch( noticesStore ).createErrorNotice( errorMessage, {
			type: 'snackbar',
		} );
	} finally {
		registry.dispatch( coreDataStore ).__unstableReleaseStoreLock( lock );
	}
};

const getDesiredMenuItems = ( post, oldMenuItems ) => ( { dispatch } ) => {
	const entityIdToBlockId = dispatch(
		getEntityRecordIdToBlockIdMapping( post.id )
	);

	const blockIdToOldEntityRecord = {};
	for ( const oldMenuItem of oldMenuItems ) {
		const blockId = entityIdToBlockId[ oldMenuItem.id ];
		if ( blockId ) {
			blockIdToOldEntityRecord[ blockId ] = oldMenuItem;
		}
	}

	const blocksList = blocksTreeToFlatList( post.blocks[ 0 ].innerBlocks );
	return blocksList.map( ( { block, parentBlockId }, idx ) =>
		blockToMenuItem(
			block,
			blockIdToOldEntityRecord[ block.clientId ],
			blockIdToOldEntityRecord[ parentBlockId ]?.id,
			idx,
			post.meta.menuId
		)
	);
};

const getEntityRecordIdToBlockIdMapping = ( postId ) => ( { registry } ) =>
	registry.stores[ STORE_NAME ].store.getState().mapping[ postId ] || {};

const batchSaveChanges = (
	kind,
	type,
	oldEntityRecords,
	desiredEntityRecords
) => async ( { dispatch, registry } ) => {
	const changeset = dispatch(
		prepareChangeset( kind, type, oldEntityRecords, desiredEntityRecords )
	);

	const results = await registry
		.dispatch( coreDataStore )
		.__experimentalBatch( changeset.map( ( { batchTask } ) => batchTask ) );

	const failures = dispatch(
		getFailedChanges( kind, type, changeset, results )
	);

	if ( failures.length ) {
		throw new Error(
			sprintf(
				/* translators: %s: List of numeric ids */
				__( 'Could not save the following records: %s.' ),
				failures.map( ( { id } ) => id ).join( ', ' )
			)
		);
	}

	return results;
};

const getFailedChanges = ( kind, entityType, changeset, results ) => ( {
	registry,
} ) => {
	const failedDeletes = zip( changeset, results )
		.filter(
			( [ change, result ] ) =>
				change.type === 'delete' &&
				! result?.hasOwnProperty( 'deleted' )
		)
		.map( ( [ change ] ) => change );

	const failedUpdates = changeset.filter(
		( change ) =>
			change.type === 'update' &&
			change.id &&
			registry
				.select( coreDataStore )
				.getLastEntitySaveError( kind, entityType, change.id )
	);

	return [ ...failedDeletes, ...failedUpdates ];
};

const prepareChangeset = (
	kind,
	type,
	oldEntityRecords,
	desiredEntityRecords
) => ( { registry } ) => {
	const deletedEntityRecordsIds = new Set(
		diff(
			oldEntityRecords.map( ( { id } ) => id ),
			desiredEntityRecords.map( ( { id } ) => id )
		)
	);

	const changes = [];
	// Enqueue updates
	for ( const entityRecord of desiredEntityRecords ) {
		if (
			! entityRecord?.id ||
			deletedEntityRecordsIds.has( entityRecord?.id )
		) {
			continue;
		}

		// Update an existing entity record.
		registry
			.dispatch( coreDataStore )
			.editEntityRecord( kind, type, entityRecord.id, entityRecord, {
				undoIgnore: true,
			} );

		const hasEdits = registry
			.select( coreDataStore )
			.hasEditsForEntityRecord( kind, type, entityRecord.id );

		if ( ! hasEdits ) {
			continue;
		}

		changes.unshift( {
			type: 'update',
			id: entityRecord.id,
			batchTask: ( { saveEditedEntityRecord } ) =>
				saveEditedEntityRecord( kind, type, entityRecord.id ),
		} );
	}

	// Enqueue deletes
	for ( const entityRecordId of deletedEntityRecordsIds ) {
		changes.unshift( {
			type: 'delete',
			id: entityRecordId,
			batchTask: ( { deleteEntityRecord } ) =>
				deleteEntityRecord( kind, type, entityRecordId, {
					force: true,
				} ),
		} );
	}

	return changes;
};

function diff( listA, listB ) {
	const setB = new Set( listB );
	return listA.filter( ( x ) => ! setB.has( x ) );
}

function blocksTreeToFlatList( innerBlocks, parentBlockId = null ) {
	return innerBlocks.flatMap( ( block, index ) =>
		[ { block, parentBlockId, childIndex: index } ].concat(
			blocksTreeToFlatList( block.innerBlocks, block.clientId )
		)
	);
}

/**
 * Returns an action object used to open/close the inserter.
 *
 * @param {boolean|Object} value                Whether the inserter should be
 *                                              opened (true) or closed (false).
 *                                              To specify an insertion point,
 *                                              use an object.
 * @param {string}         value.rootClientId   The root client ID to insert at.
 * @param {number}         value.insertionIndex The index to insert at.
 *
 * @return {Object} Action object.
 */
export function setIsInserterOpened( value ) {
	return {
		type: 'SET_IS_INSERTER_OPENED',
		value,
	};
}
